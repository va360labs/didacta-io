import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import { chunkText, type Chunk } from './chunker.js';
import { CourseNotPublishedError, EmbeddingsProviderError } from './errors.js';
import { extractLessonText, type LessonType } from './lesson-extractor.js';
import type { IndexCourseResultView } from './dto.js';

/**
 * Servicio de indexación de cursos para el tutor IA (LMS-90.C).
 *
 * Flujo de `indexCourse(tenantId, courseId, opts)`:
 *   1. Verifica que el curso existe en el tenant y está PUBLISHED (a no ser
 *      que `opts.allowDraft = true`, útil en tests).
 *   2. Recupera todos los módulos y lecciones no soft-deleted del curso.
 *   3. Para cada lección, extrae texto plano vía `extractLessonText`.
 *   4. Concatena el texto de todas las lecciones agrupado por módulo (con
 *      cabecera de módulo) — preserva contexto en los chunks.
 *   5. Chunkea con `chunkText` (~500 tokens, overlap 50).
 *   6. Si `opts.force = true`, borra chunks previos del curso antes de
 *      insertar. Si no, hace upsert delete+insert (siempre limpia primero
 *      para evitar mezcla de versiones).
 *   7. Genera embeddings en batch via el AI Gateway (`embedFn` inyectado).
 *   8. Persiste filas en `mod_ai_tutor_chunk` usando $queryRaw para insertar
 *      el embedding como vector (Prisma client no acepta el tipo).
 *   9. Emite `ai-tutor.course.indexed` con conteos.
 *
 * El servicio NO depende del NestJS `AiGatewayService` directamente — recibe
 * una `embedFn` por constructor para que sea testeable y portable.
 */

export interface EmbedFn {
  (args: {
    tenantId: string;
    texts: string[];
  }): Promise<{ embeddings: number[][]; totalTokens: number; dimension: number }>;
}

export interface IndexCourseOptions {
  /** Si true, fuerza re-indexación incluso si el curso no está PUBLISHED. */
  allowDraft?: boolean;
  /** Si true, lo mismo que default — limpia chunks previos antes de insertar.
   * Mantenido como flag explícito para futura semántica de "merge" si la añadimos. */
  force?: boolean;
}

interface CourseRow {
  id: string;
  tenantId: string;
  status: string;
}

interface ModuleRow {
  id: string;
  title: string;
  position: number;
}

interface LessonRow {
  id: string;
  moduleId: string;
  type: LessonType;
  title: string;
  content: unknown;
  position: number;
}

interface PreparedChunk extends Chunk {
  /** Lección de origen del chunk; null si es chunk de descripción del curso. */
  lessonId: string | null;
}

/** Resultado de reindexar una sola lección. */
export interface IndexLessonResult {
  lessonId: string;
  /** Curso al que pertenece, null si no se pudo resolver. */
  courseId: string | null;
  chunksGenerated: number;
  tokensUsed: number;
  /** Motivo por el que no se indexó, o null si sí se indexó. */
  skipped: string | null;
  durationMs: number;
}

export class AiTutorIndexerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
    private readonly embedFn: EmbedFn,
  ) {}

  async indexCourse(
    tenantId: string,
    courseId: string,
    opts: IndexCourseOptions = {},
  ): Promise<IndexCourseResultView> {
    const start = Date.now();

    const course = (await this.prisma.modCoursesCourse.findFirst({
      where: { tenantId, id: courseId, deletedAt: null },
      select: { id: true, tenantId: true, status: true },
    })) as CourseRow | null;
    if (!course) {
      throw new Error(`Course ${courseId} not found in tenant ${tenantId}`);
    }
    if (!opts.allowDraft && course.status !== 'PUBLISHED') {
      throw new CourseNotPublishedError(courseId);
    }

    const modules = (await this.prisma.modCoursesModule.findMany({
      where: { tenantId, courseId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true, title: true, position: true },
    })) as ModuleRow[];

    const lessonsByModule = new Map<string, LessonRow[]>();
    if (modules.length > 0) {
      const lessons = (await this.prisma.modCoursesLesson.findMany({
        where: {
          tenantId,
          moduleId: { in: modules.map((m) => m.id) },
          deletedAt: null,
        },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          moduleId: true,
          type: true,
          title: true,
          content: true,
          position: true,
        },
      })) as LessonRow[];
      for (const l of lessons) {
        const arr = lessonsByModule.get(l.moduleId) ?? [];
        arr.push(l);
        lessonsByModule.set(l.moduleId, arr);
      }
    }

    let lessonsProcessed = 0;
    const prepared: PreparedChunk[] = [];

    for (const module of modules) {
      const lessons = lessonsByModule.get(module.id) ?? [];
      for (const lesson of lessons) {
        const extracted = extractLessonText({
          type: lesson.type,
          title: lesson.title,
          content: (lesson.content as Record<string, unknown>) ?? {},
        });
        if (!extracted.text) {
          this.ctx.logger.debug('mod.ai-tutor: skip lesson en indexación', {
            lessonId: lesson.id,
            reason: extracted.skipReason,
          });
          continue;
        }
        // Prepend cabecera de módulo para contexto en el RAG
        const withModuleHeader = `[Módulo ${module.position + 1}: ${module.title}]\n\n${extracted.text}`;
        const lessonChunks = chunkText(withModuleHeader);
        for (const c of lessonChunks) {
          prepared.push({ ...c, lessonId: lesson.id });
        }
        lessonsProcessed++;
      }
    }

    // Limpia chunks previos del curso (siempre — re-indexación idempotente).
    await this.prisma.$executeRawUnsafe(
      'DELETE FROM "mod_ai_tutor_chunk" WHERE "tenant_id" = $1::uuid AND "course_id" = $2::uuid',
      tenantId,
      courseId,
    );

    if (prepared.length === 0) {
      this.ctx.logger.warn(
        'mod.ai-tutor: curso sin chunks indexables (todas las lecciones omitidas)',
        { tenantId, courseId },
      );
      await this.publish(tenantId, 'ai-tutor.course.indexed', {
        courseId,
        lessonsProcessed,
        chunksGenerated: 0,
        tokensUsed: 0,
      });
      return {
        courseId,
        lessonsProcessed,
        chunksGenerated: 0,
        tokensUsed: 0,
        durationMs: Date.now() - start,
      };
    }

    // Embed en batch. Si el batch es enorme (>100 chunks) lo partimos para
    // evitar request bodies enormes / timeouts.
    const BATCH_SIZE = 64;
    let totalTokens = 0;
    let dimension = 0;
    const embeddings: number[][] = new Array(prepared.length);

    for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
      const batch = prepared.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.content);
      let result;
      try {
        result = await this.embedFn({ tenantId, texts });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.publish(tenantId, 'ai-tutor.course.index-failed', {
          courseId,
          batchIndex: i,
          reason,
        });
        throw new EmbeddingsProviderError('gateway', reason);
      }
      if (result.embeddings.length !== batch.length) {
        throw new EmbeddingsProviderError(
          'gateway',
          `embeddings count mismatch: esperados ${batch.length}, recibidos ${result.embeddings.length}`,
        );
      }
      totalTokens += result.totalTokens;
      dimension = result.dimension;
      for (let j = 0; j < batch.length; j++) {
        embeddings[i + j] = result.embeddings[j]!;
      }
    }

    // Validación de dimensión: el schema espera vector(1536). Si el provider
    // devuelve otra dim, fallar early con mensaje claro (mejor que insertar
    // y romper a nivel SQL).
    const EXPECTED_DIM = 1536;
    if (dimension !== EXPECTED_DIM) {
      throw new EmbeddingsProviderError(
        'gateway',
        `dimensión ${dimension} ≠ esperada ${EXPECTED_DIM}. ` +
          'El schema mod_ai_tutor_chunk usa vector(1536). ' +
          'Reconfigura el provider de embeddings del tenant o migra el schema.',
      );
    }

    // Insert en lote vía $queryRaw para poder pasar el array como vector.
    // pgvector acepta string '[a,b,c]' como input para columna vector(N).
    for (let i = 0; i < prepared.length; i++) {
      const chunk = prepared[i]!;
      const embStr = '[' + embeddings[i]!.join(',') + ']';
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "mod_ai_tutor_chunk"
         ("id", "tenant_id", "course_id", "lesson_id", "ordinal", "content", "embedding", "tokens_count", "created_at")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::vector, $8, NOW())`,
        randomUUID(),
        tenantId,
        courseId,
        chunk.lessonId,
        chunk.ordinal,
        chunk.content,
        embStr,
        chunk.tokensCount,
      );
    }

    await this.publish(tenantId, 'ai-tutor.course.indexed', {
      courseId,
      lessonsProcessed,
      chunksGenerated: prepared.length,
      tokensUsed: totalTokens,
    });

    this.ctx.logger.info('mod.ai-tutor: curso indexado', {
      tenantId,
      courseId,
      lessonsProcessed,
      chunksGenerated: prepared.length,
      tokensUsed: totalTokens,
      durationMs: Date.now() - start,
    });

    return {
      courseId,
      lessonsProcessed,
      chunksGenerated: prepared.length,
      tokensUsed: totalTokens,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Reindexa UNA lección. Es el camino normal cuando el formador sube una clase
   * nueva o pega su transcripción: reindexar el curso entero costaría cientos de
   * embeddings para cambiar una lección.
   *
   * Idempotente: borra los chunks de esa lección y vuelve a generarlos. Si el
   * curso no está publicado o la lección no tiene texto indexable, deja el
   * índice limpio y devuelve 0 chunks — nunca lanza por eso, porque va colgado
   * de un evento y no debe tumbar el guardado de la lección.
   */
  async indexLesson(tenantId: string, lessonId: string): Promise<IndexLessonResult> {
    const start = Date.now();
    const vacio = (motivo: string): IndexLessonResult => ({
      lessonId,
      courseId: null,
      chunksGenerated: 0,
      tokensUsed: 0,
      skipped: motivo,
      durationMs: Date.now() - start,
    });

    const lesson = (await this.prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: lessonId, deletedAt: null },
      select: { id: true, moduleId: true, type: true, title: true, content: true },
    })) as (LessonRow & { moduleId: string }) | null;
    if (!lesson) return vacio('lección inexistente o borrada');

    const courseModule = (await this.prisma.modCoursesModule.findFirst({
      where: { tenantId, id: lesson.moduleId, deletedAt: null },
      select: { id: true, courseId: true, title: true, position: true },
    })) as (ModuleRow & { courseId: string }) | null;
    if (!courseModule) return vacio('módulo inexistente o borrado');

    const courseId = courseModule.courseId;
    const course = (await this.prisma.modCoursesCourse.findFirst({
      where: { tenantId, id: courseId, deletedAt: null },
      select: { status: true },
    })) as { status: string } | null;
    if (!course) return { ...vacio('curso inexistente'), courseId };
    if (course.status !== 'PUBLISHED') {
      return { ...vacio('curso no publicado'), courseId };
    }

    // Fuera los chunks viejos de esta lección, pase lo que pase después: si la
    // lección se quedó sin texto, lo correcto es que el tutor deje de citarla.
    await this.prisma.$executeRawUnsafe(
      'DELETE FROM "mod_ai_tutor_chunk" WHERE "tenant_id" = $1::uuid AND "lesson_id" = $2::uuid',
      tenantId,
      lessonId,
    );

    const extracted = extractLessonText({
      type: lesson.type,
      title: lesson.title,
      content: (lesson.content as Record<string, unknown>) ?? {},
    });
    if (!extracted.text) {
      return { ...vacio(extracted.skipReason ?? 'sin texto indexable'), courseId };
    }

    const withModuleHeader = `[Módulo ${courseModule.position + 1}: ${courseModule.title}]\n\n${extracted.text}`;
    const chunks = chunkText(withModuleHeader);
    if (chunks.length === 0) return { ...vacio('el troceado no produjo nada'), courseId };

    const { embeddings, totalTokens } = await this.embedInBatches(
      tenantId,
      chunks.map((c) => c.content),
      courseId,
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "mod_ai_tutor_chunk"
         ("id", "tenant_id", "course_id", "lesson_id", "ordinal", "content", "embedding", "tokens_count", "created_at")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::vector, $8, NOW())`,
        randomUUID(),
        tenantId,
        courseId,
        lessonId,
        chunk.ordinal,
        chunk.content,
        '[' + embeddings[i]!.join(',') + ']',
        chunk.tokensCount,
      );
    }

    this.ctx.logger.info('mod.ai-tutor: lección reindexada', {
      tenantId,
      courseId,
      lessonId,
      chunksGenerated: chunks.length,
      tokensUsed: totalTokens,
      durationMs: Date.now() - start,
    });

    return {
      lessonId,
      courseId,
      chunksGenerated: chunks.length,
      tokensUsed: totalTokens,
      skipped: null,
      durationMs: Date.now() - start,
    };
  }

  /** Borra los chunks de una lección (al borrarla). Idempotente. */
  async unindexLesson(tenantId: string, lessonId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      'DELETE FROM "mod_ai_tutor_chunk" WHERE "tenant_id" = $1::uuid AND "lesson_id" = $2::uuid',
      tenantId,
      lessonId,
    );
  }

  /**
   * Genera embeddings en lotes y valida la dimensión. Compartido por la
   * indexación de curso y la de lección.
   */
  private async embedInBatches(
    tenantId: string,
    texts: string[],
    courseId: string,
  ): Promise<{ embeddings: number[][]; totalTokens: number }> {
    const BATCH_SIZE = 64;
    const embeddings: number[][] = new Array(texts.length);
    let totalTokens = 0;
    let dimension = 0;

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      let result;
      try {
        result = await this.embedFn({ tenantId, texts: batch });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.publish(tenantId, 'ai-tutor.course.index-failed', {
          courseId,
          batchIndex: i,
          reason,
        });
        throw new EmbeddingsProviderError('gateway', reason);
      }
      if (result.embeddings.length !== batch.length) {
        throw new EmbeddingsProviderError(
          'gateway',
          `embeddings count mismatch: esperados ${batch.length}, recibidos ${result.embeddings.length}`,
        );
      }
      totalTokens += result.totalTokens;
      dimension = result.dimension;
      for (let j = 0; j < batch.length; j++) embeddings[i + j] = result.embeddings[j]!;
    }

    const EXPECTED_DIM = 1536;
    if (dimension !== EXPECTED_DIM) {
      throw new EmbeddingsProviderError(
        'gateway',
        `dimensión ${dimension} ≠ esperada ${EXPECTED_DIM}. ` +
          'El schema mod_ai_tutor_chunk usa vector(1536). ' +
          'Reconfigura el provider de embeddings del tenant o migra el schema.',
      );
    }

    return { embeddings, totalTokens };
  }

  /**
   * Limpia chunks de un curso (al despublicar / borrar). Idempotente.
   */
  async unindexCourse(tenantId: string, courseId: string): Promise<void> {
    const result = (await this.prisma.$executeRawUnsafe(
      'DELETE FROM "mod_ai_tutor_chunk" WHERE "tenant_id" = $1::uuid AND "course_id" = $2::uuid',
      tenantId,
      courseId,
    )) as unknown as number;
    this.ctx.logger.info('mod.ai-tutor: curso desindexado', {
      tenantId,
      courseId,
      deleted: result,
    });
    await this.publish(tenantId, 'ai-tutor.course.indexed', {
      courseId,
      lessonsProcessed: 0,
      chunksGenerated: 0,
      tokensUsed: 0,
      unindexed: true,
    });
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
