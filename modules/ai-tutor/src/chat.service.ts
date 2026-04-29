import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type { AskDto, AskResponseView, CitationView } from './dto.js';
import { ChatProviderError, CourseNotIndexedError, EmbeddingsProviderError } from './errors.js';
import {
  buildPrompt,
  extractCitations,
  trimHistoryToBudget,
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
  ): Promise<AskResponseView> {
    // 1. Curso indexado
    const indexed = (await this.prisma.modAiTutorChunk.count({
      where: { tenantId, courseId },
    })) as number;
    if (indexed === 0) {
      throw new CourseNotIndexedError(courseId);
    }

    // 2. Resolver/crear conversación
    const conversationId = await this.resolveConversation({
      tenantId,
      userId,
      courseId,
      providedId: dto.conversationId,
    });

    // 3. Cargar histórico y recortar
    const historyRows = (await this.prisma.modAiTutorMessage.findMany({
      where: { tenantId, conversationId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true, createdAt: true },
    })) as MessageRow[];
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

    // 5. Cosine search via pgvector
    const topK = dto.topK ?? DEFAULT_TOP_K;
    const embeddingStr = '[' + queryEmbedding.join(',') + ']';
    const retrievedRaw = (await this.prisma.$queryRawUnsafe(
      `SELECT
         "id"::text AS "id",
         "lesson_id"::text AS "lesson_id",
         "content",
         ("embedding" <=> $1::vector)::float AS "distance"
       FROM "mod_ai_tutor_chunk"
       WHERE "tenant_id" = $2::uuid AND "course_id" = $3::uuid
       ORDER BY "embedding" <=> $1::vector
       LIMIT $4`,
      embeddingStr,
      tenantId,
      courseId,
      topK,
    )) as ChunkRetrievalRow[];

    const retrieved: RetrievedChunk[] = retrievedRaw.map((r) => ({
      id: r.id,
      lessonId: r.lesson_id,
      content: r.content,
      distance: r.distance,
    }));

    // 6. Construir prompt
    const courseTitle = await this.resolveCourseTitle(tenantId, courseId);
    const userLocale = await this.resolveUserLocale(userId);
    const prompt = buildPrompt({
      courseTitle,
      locale: userLocale,
      retrieved,
      history: historyTrimmed,
      question: dto.question,
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

    // 10. Actualizar token usage agregado del día
    await this.bumpTokenUsage({
      tenantId,
      userId,
      inputTokens: totalInputTokens,
      outputTokens: chatResult.outputTokens,
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

    return {
      answer: chatResult.content,
      citations,
      conversationId,
      tokensUsed: {
        input: totalInputTokens,
        output: chatResult.outputTokens,
      },
    };
  }

  private async resolveConversation(args: {
    tenantId: string;
    userId: string;
    courseId: string;
    providedId?: string;
  }): Promise<string> {
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
      if (existing) return existing.id;
      // ID inválido o ajeno → crear nueva (más amigable que 404).
    }
    const id = randomUUID();
    await this.prisma.modAiTutorConversation.create({
      data: {
        id,
        tenantId: args.tenantId,
        userId: args.userId,
        courseId: args.courseId,
      },
    });
    return id;
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
    // Para snippet usamos los primeros 200 chars del content del chunk;
    // necesitamos el chunk content que NO está en `parsed`. Lo recuperamos
    // en una sola query.
    const chunkIds = parsed.map((p) => p.chunkId);
    const chunkSnippets = new Map<string, string>();
    if (chunkIds.length > 0) {
      const chunks = await this.prisma.modAiTutorChunk.findMany({
        where: { tenantId, id: { in: chunkIds } },
        select: { id: true, content: true },
      });
      for (const c of chunks) {
        chunkSnippets.set(c.id, (c.content as string).slice(0, 200));
      }
    }

    return parsed.map((p) => ({
      lessonId: p.lessonId ?? '',
      lessonTitle: p.lessonId ? (lessonTitles.get(p.lessonId) ?? null) : null,
      chunkOrdinal: p.index,
      snippet: chunkSnippets.get(p.chunkId) ?? '',
    }));
  }

  private async bumpTokenUsage(args: {
    tenantId: string;
    userId: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
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
