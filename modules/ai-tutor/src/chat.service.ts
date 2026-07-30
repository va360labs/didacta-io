import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type { AskDto, AskResponseView, CitationView } from './dto.js';
import {
  ChatProviderError,
  CourseAccessDeniedError,
  CourseNotIndexedError,
  DailyQuestionQuotaExceededError,
  EmbeddingsProviderError,
} from './errors.js';
import {
  buildPrompt,
  extractCitations,
  parseStartSeconds,
  trimHistoryToBudget,
  type LessonContext,
  type PriorMessage,
  type RetrievedChunk,
} from './prompt-builder.js';

/**
 * Servicio del chat tutor IA con RAG (LMS-90.D).
 *
 * Flujo de `ask(tenantId, userId, courseId, dto)`:
 *   1. Verifica que existe al menos un chunk indexado para (tenant, course).
 *      Si no, lanza CourseNotIndexedError.
 *   2. Resuelve o crea la conversación. Si dto.conversationId, valida
 *      ownership (mismo userId+courseId+tenant); si no, crea nueva.
 *   3. Carga histórico de mensajes y lo recorta al budget (3000 tokens).
 *   4. Genera embedding de la pregunta del alumno via embedFn.
 *   5. Hace cosine search en mod_ai_tutor_chunk via $queryRaw con
 *      operador <=> de pgvector. Top-K (default 5).
 *   6. Construye prompt con buildPrompt: system + retrieved + history + question.
 *   7. Llama chatFn (delega al AI Gateway con provider del tenant).
 *   8. Extrae citas [N] de la respuesta y las mapea a lecciones.
 *   9. Persiste mensaje user + assistant en mod_ai_tutor_message.
 *   10. Actualiza mod_ai_tutor_token_usage agregado por (tenant, user, día).
 *   11. Emite ai-tutor.chat.message-received.
 *
 * Las funciones embedFn y chatFn son inyectadas — el service no se acopla
 * al AI Gateway concreto. En tests se mockean.
 */

export interface EmbedFn {
  (args: {
    tenantId: string;
    texts: string[];
  }): Promise<{ embeddings: number[][]; totalTokens: number; dimension: number }>;
}

export interface ChatFn {
  (args: {
    tenantId: string;
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
  }): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

interface ChunkRetrievalRow {
  id: string;
  lesson_id: string | null;
  content: string;
  distance: number;
}

interface ConversationRow {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
}

interface MessageRow {
  role: string;
  content: string;
  createdAt: Date;
}

const DEFAULT_TOP_K = 5;
const HISTORY_TOKEN_BUDGET = 3000;

/**
 * Preguntas al tutor por alumno y día. La unidad es la pregunta, no el token:
 * es lo que el alumno entiende y lo que el formador puede decidir.
 */
export const DAILY_QUESTION_LIMIT = 10;

/**
 * Fragmentos de la lección que el alumno está viendo que se garantizan en el
 * contexto, además del top-K del curso entero. Sin esto, una duda muy concreta
 * de la clase actual puede quedar sepultada por fragmentos de otras lecciones
 * que hablan del mismo concepto de forma más genérica.
 */
const LESSON_PINNED = 3;

/** Medianoche UTC de hoy — la clave de la fila agregada de consumo. */
function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Opciones de servicio (no vienen del alumno; las decide el controller). */
export interface AskOptions {
  /**
   * Formador o admin probando el tutor: se salta la comprobación de matrícula
   * y la cuota diaria. Nunca se activa desde el cuerpo de la petición.
   */
  staff?: boolean;
}

export class AiTutorChatService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
    private readonly embedFn: EmbedFn,
    private readonly chatFn: ChatFn,
  ) {}

  async ask(
    tenantId: string,
    userId: string,
    courseId: string,
    dto: AskDto,
    opts: AskOptions = {},
  ): Promise<AskResponseView> {
    // 0. Acceso. La ficha del curso ya esconde el contenido sin matrícula; sin
    //    esto el tutor era una puerta trasera para leerlo resumido.
    if (!opts.staff) {
      await this.assertEnrolled(tenantId, userId, courseId);
    }

    // 0.b Cuota diaria. Se comprueba ANTES de gastar en embeddings ni chat.
    const preguntasHoy = opts.staff ? 0 : await this.countQuestionsToday(tenantId, userId);
    if (!opts.staff && preguntasHoy >= DAILY_QUESTION_LIMIT) {
      throw new DailyQuestionQuotaExceededError(preguntasHoy, DAILY_QUESTION_LIMIT);
    }

    // 1. Curso indexado
    const indexed = (await this.prisma.modAiTutorChunk.count({
      where: { tenantId, courseId },
    })) as number;
    if (indexed === 0) {
      throw new CourseNotIndexedError(courseId);
    }

    // 2. Resolver conversación. Si es nueva NO se inserta todavía: se crea en la
    //    misma transacción que los mensajes. Antes se creaba aquí y cualquier
    //    fallo posterior dejaba una conversación vacía — así se acumularon 5
    //    conversaciones sin un solo mensaje mientras el tutor daba 502.
    const { conversationId, isNew } = await this.resolveConversation({
      tenantId,
      userId,
      courseId,
      providedId: dto.conversationId,
    });

    // 3. Cargar histórico y recortar
    const historyRows = isNew
      ? []
      : ((await this.prisma.modAiTutorMessage.findMany({
          where: { tenantId, conversationId },
          orderBy: { createdAt: 'asc' },
          select: { role: true, content: true, createdAt: true },
        })) as MessageRow[]);
    const historyTrimmed = trimHistoryToBudget(
      historyRows.map<PriorMessage>((r) => ({
        role: r.role === 'assistant' ? 'assistant' : 'user',
        content: r.content,
      })),
      HISTORY_TOKEN_BUDGET,
    );

    // 4. Embedding de la pregunta
    let queryEmbedding: number[];
    let embedTokens = 0;
    try {
      const embedResult = await this.embedFn({
        tenantId,
        texts: [dto.question],
      });
      if (embedResult.embeddings.length === 0) {
        throw new EmbeddingsProviderError('gateway', 'embed devolvió 0 vectores');
      }
      queryEmbedding = embedResult.embeddings[0]!;
      embedTokens = embedResult.totalTokens;
    } catch (err) {
      if (err instanceof EmbeddingsProviderError) throw err;
      throw new EmbeddingsProviderError(
        'gateway',
        err instanceof Error ? err.message : String(err),
      );
    }

    // 5. Cosine search via pgvector. Cuando sabemos qué lección está viendo,
    //    reservamos hueco para sus fragmentos: la misma duda ("no me va el
    //    webhook") se responde distinto en el capítulo 21 que en el 45.
    const topK = dto.topK ?? DEFAULT_TOP_K;
    const embeddingStr = '[' + queryEmbedding.join(',') + ']';

    const buscar = (lessonId: string | null, limit: number) =>
      this.prisma.$queryRawUnsafe(
        `SELECT
           "id"::text AS "id",
           "lesson_id"::text AS "lesson_id",
           "content",
           ("embedding" <=> $1::vector)::float AS "distance"
         FROM "mod_ai_tutor_chunk"
         WHERE "tenant_id" = $2::uuid AND "course_id" = $3::uuid
           ${lessonId ? 'AND "lesson_id" = $5::uuid' : ''}
         ORDER BY "embedding" <=> $1::vector
         LIMIT $4`,
        ...[embeddingStr, tenantId, courseId, limit, ...(lessonId ? [lessonId] : [])],
      ) as Promise<ChunkRetrievalRow[]>;

    const [delCurso, deLaLeccion] = await Promise.all([
      buscar(null, topK),
      dto.lessonId ? buscar(dto.lessonId, LESSON_PINNED) : Promise.resolve([]),
    ]);

    // Los de la lección actual van primero (son los que el alumno tiene
    // delante) y el resto del curso completa sin repetir.
    const vistos = new Set<string>();
    const retrieved: RetrievedChunk[] = [];
    for (const r of [...deLaLeccion, ...delCurso]) {
      if (vistos.has(r.id)) continue;
      vistos.add(r.id);
      retrieved.push({
        id: r.id,
        lessonId: r.lesson_id,
        content: r.content,
        distance: r.distance,
        esLeccionActual: !!dto.lessonId && r.lesson_id === dto.lessonId,
      });
    }

    // 6. Construir prompt
    const courseTitle = await this.resolveCourseTitle(tenantId, courseId);
    const userLocale = await this.resolveUserLocale(userId);
    const lessonTitles = await this.resolveLessonTitles(
      tenantId,
      retrieved
        .map((r) => r.lessonId)
        .filter((id): id is string => id !== null)
        .concat(dto.lessonId ? [dto.lessonId] : []),
    );
    for (const r of retrieved) {
      r.lessonTitle = r.lessonId ? (lessonTitles.get(r.lessonId) ?? null) : null;
    }
    const lessonContext: LessonContext | null =
      dto.lessonId && lessonTitles.has(dto.lessonId)
        ? {
            lessonId: dto.lessonId,
            lessonTitle: lessonTitles.get(dto.lessonId)!,
            positionSeconds: dto.positionSeconds,
          }
        : null;
    const prompt = buildPrompt({
      courseTitle,
      locale: userLocale,
      retrieved,
      history: historyTrimmed,
      question: dto.question,
      lessonContext,
    });

    // 7. Llamada chat
    let chatResult;
    try {
      chatResult = await this.chatFn({
        tenantId,
        system: prompt.system,
        messages: prompt.messages,
        maxTokens: 1500,
      });
    } catch (err) {
      throw new ChatProviderError('gateway', err instanceof Error ? err.message : String(err));
    }

    // 8. Extraer citas
    const parsedCitations = extractCitations(chatResult.content, retrieved);
    const citations = await this.hydrateCitations(tenantId, parsedCitations);

    // 9. Persistir mensajes (user + assistant) en una transacción
    const userMsgId = randomUUID();
    const assistantMsgId = randomUUID();
    const totalInputTokens = embedTokens + chatResult.inputTokens;
    await this.prisma.$transaction([
      ...(isNew
        ? [
            this.prisma.modAiTutorConversation.create({
              data: { id: conversationId, tenantId, userId, courseId },
            }),
          ]
        : []),
      this.prisma.modAiTutorMessage.create({
        data: {
          id: userMsgId,
          tenantId,
          conversationId,
          role: 'user',
          content: dto.question,
          citations: [],
          tokensInput: 0,
          tokensOutput: 0,
        },
      }),
      this.prisma.modAiTutorMessage.create({
        data: {
          id: assistantMsgId,
          tenantId,
          conversationId,
          role: 'assistant',
          content: chatResult.content,
          citations: parsedCitations as never,
          tokensInput: totalInputTokens,
          tokensOutput: chatResult.outputTokens,
        },
      }),
    ]);

    // 10. Actualizar consumo agregado del día (tokens y preguntas)
    await this.bumpTokenUsage({
      tenantId,
      userId,
      inputTokens: totalInputTokens,
      outputTokens: chatResult.outputTokens,
      countsAgainstQuota: !opts.staff,
    });

    // 11. Evento
    await this.publish(tenantId, 'ai-tutor.chat.message-received', {
      conversationId,
      userId,
      courseId,
      retrievedCount: retrieved.length,
      citationsCount: citations.length,
      tokensInput: totalInputTokens,
      tokensOutput: chatResult.outputTokens,
    });

    const usadas = opts.staff ? preguntasHoy : preguntasHoy + 1;
    return {
      answer: chatResult.content,
      citations,
      conversationId,
      tokensUsed: {
        input: totalInputTokens,
        output: chatResult.outputTokens,
      },
      quota: {
        used: usadas,
        limit: DAILY_QUESTION_LIMIT,
        remaining: Math.max(0, DAILY_QUESTION_LIMIT - usadas),
      },
    };
  }

  /**
   * El alumno debe estar matriculado en el curso. Una matrícula CANCELLED no
   * vale: es el mismo criterio con el que la ficha del curso decide si enseña
   * el contenido o el panel de venta.
   */
  private async assertEnrolled(tenantId: string, userId: string, courseId: string): Promise<void> {
    const enrollment = await this.prisma.modLearningEnrollment.findFirst({
      where: { tenantId, userId, courseId, status: { not: 'CANCELLED' } },
      select: { id: true },
    });
    if (!enrollment) throw new CourseAccessDeniedError(courseId);
  }

  /** Preguntas que lleva hoy el alumno (UTC, igual que la fila agregada). */
  private async countQuestionsToday(tenantId: string, userId: string): Promise<number> {
    const row = await this.prisma.modAiTutorTokenUsage.findFirst({
      where: { tenantId, userId, day: startOfUtcDay() },
      select: { questions: true },
    });
    return row?.questions ?? 0;
  }

  private async resolveConversation(args: {
    tenantId: string;
    userId: string;
    courseId: string;
    providedId?: string;
  }): Promise<{ conversationId: string; isNew: boolean }> {
    if (args.providedId) {
      const existing = (await this.prisma.modAiTutorConversation.findFirst({
        where: {
          id: args.providedId,
          tenantId: args.tenantId,
          userId: args.userId,
          courseId: args.courseId,
        },
        select: { id: true },
      })) as { id: string } | null;
      if (existing) return { conversationId: existing.id, isNew: false };
      // ID inválido o ajeno → arrancamos una nueva (más amigable que un 404).
    }
    // Sólo se reserva el id. La fila se inserta junto a los mensajes, para no
    // dejar conversaciones vacías si el proveedor de IA falla.
    return { conversationId: randomUUID(), isNew: true };
  }

  /** Títulos de lección por id, en una sola query. Vacío si algo falla. */
  private async resolveLessonTitles(
    tenantId: string,
    lessonIds: string[],
  ): Promise<Map<string, string>> {
    const unicos = Array.from(new Set(lessonIds));
    const map = new Map<string, string>();
    if (unicos.length === 0) return map;
    try {
      const rows = await this.prisma.modCoursesLesson.findMany({
        where: { tenantId, id: { in: unicos } },
        select: { id: true, title: true },
      });
      for (const r of rows) map.set(r.id, r.title);
    } catch {
      /* sin títulos el tutor sigue respondiendo, sólo cita peor */
    }
    return map;
  }

  private async resolveCourseTitle(tenantId: string, courseId: string): Promise<string> {
    try {
      const row = await this.prisma.modCoursesCourse.findFirst({
        where: { tenantId, id: courseId },
        select: { title: true },
      });
      return row?.title ?? 'Curso';
    } catch {
      return 'Curso';
    }
  }

  private async resolveUserLocale(userId: string): Promise<string> {
    try {
      const row = await this.prisma.user.findFirst({
        where: { id: userId },
        select: { locale: true },
      });
      return row?.locale ?? 'es';
    } catch {
      return 'es';
    }
  }

  private async hydrateCitations(
    tenantId: string,
    parsed: Array<{ index: number; lessonId: string | null; chunkId: string }>,
  ): Promise<CitationView[]> {
    const lessonIds = Array.from(
      new Set(parsed.map((p) => p.lessonId).filter((id): id is string => id !== null)),
    );
    const lessonTitles = new Map<string, string>();
    if (lessonIds.length > 0) {
      const rows = await this.prisma.modCoursesLesson.findMany({
        where: { tenantId, id: { in: lessonIds } },
        select: { id: true, title: true },
      });
      for (const r of rows) lessonTitles.set(r.id, r.title);
    }
    // Necesitamos el texto del chunk (no está en `parsed`) para el snippet y
    // para leer su marca de tiempo. Una sola query.
    const chunkIds = parsed.map((p) => p.chunkId);
    const chunkContents = new Map<string, string>();
    if (chunkIds.length > 0) {
      const chunks = await this.prisma.modAiTutorChunk.findMany({
        where: { tenantId, id: { in: chunkIds } },
        select: { id: true, content: true },
      });
      for (const c of chunks) {
        chunkContents.set(c.id, c.content as string);
      }
    }

    return parsed.map((p) => {
      const content = chunkContents.get(p.chunkId) ?? '';
      return {
        lessonId: p.lessonId ?? '',
        lessonTitle: p.lessonId ? (lessonTitles.get(p.lessonId) ?? null) : null,
        chunkOrdinal: p.index,
        snippet: content.slice(0, 200),
        startSeconds: parseStartSeconds(content),
      };
    });
  }

  private async bumpTokenUsage(args: {
    tenantId: string;
    userId: string;
    inputTokens: number;
    outputTokens: number;
    countsAgainstQuota: boolean;
  }): Promise<void> {
    const today = startOfUtcDay();
    const preguntas = args.countsAgainstQuota ? 1 : 0;
    // El UNIQUE de mod_ai_tutor_token_usage usa COALESCE(user_id, ...)
    // que no es accesible via Prisma upsert. Hacemos find→update/create
    // manual. Race condition residual: si dos requests caen el mismo ms
    // pueden crear dos filas, pero un sweep semanal puede consolidar.
    const existing = await this.prisma.modAiTutorTokenUsage.findFirst({
      where: {
        tenantId: args.tenantId,
        userId: args.userId,
        day: today,
      },
    });
    if (existing) {
      await this.prisma.modAiTutorTokenUsage.update({
        where: { id: existing.id },
        data: {
          tokensInput: { increment: args.inputTokens },
          tokensOutput: { increment: args.outputTokens },
          questions: { increment: preguntas },
        },
      });
    } else {
      await this.prisma.modAiTutorTokenUsage.create({
        data: {
          id: randomUUID(),
          tenantId: args.tenantId,
          userId: args.userId,
          day: today,
          tokensInput: args.inputTokens,
          tokensOutput: args.outputTokens,
          questions: preguntas,
          costCents: 0,
        },
      });
    }
  }

  private async publish(
    tenantId: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.ctx.eventBus.publish({
      name,
      version: 1,
      data,
      metadata: {
        tenantId,
        timestamp: new Date().toISOString(),
        traceId: randomUUID(),
        idempotencyKey: `${name}:${JSON.stringify(data)}:${Date.now()}`,
      },
    });
  }
}
