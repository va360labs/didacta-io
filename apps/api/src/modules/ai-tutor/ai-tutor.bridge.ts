import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

interface CoursePublishedEvent {
  courseId: string;
}

interface CourseUnpublishedEvent {
  courseId: string;
}

/** `courses.lesson.updated` sólo trae el id; el curso lo resuelve el indexer. */
interface LessonEvent {
  lessonId: string;
}

/**
 * Bridge que conecta los eventos del catálogo (mod.courses) con el indexer
 * del tutor IA (LMS-90.C).
 *
 *   - `courses.course.published` → re-indexa el curso en background.
 *   - `courses.course.unpublished` → borra los chunks del curso.
 *
 * El indexer usa el `AiGatewayService` para generar embeddings via el
 * provider configurado para el tenant. Si el tenant no tiene provider de
 * embeddings configurado, se loga warning y se omite — el curso queda sin
 * índice y el chat tutor responderá con "curso no indexado" hasta que el
 * admin lo configure.
 *
 * Idempotencia: el indexer borra chunks previos antes de insertar, así que
 * re-publicar el curso (o el outbox reentregando el evento) no genera
 * duplicados.
 */
@Injectable()
export class AiTutorBridge implements OnModuleInit {
  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly registry: ModuleRegistryService,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit() {
    const eventBus = this.factory.getEventBus();

    eventBus.subscribe<CoursePublishedEvent>('courses.course.published', async (event) => {
      const tenantId = event.metadata.tenantId;
      const { courseId } = event.data;
      const indexer = this.registry.getAiTutorIndexerServiceOrNull();
      if (!indexer) {
        this.logger.debug({ courseId, tenantId }, 'mod.ai-tutor: no activo, salto indexación');
        return;
      }
      try {
        await indexer.indexCourse(tenantId, courseId);
      } catch (err) {
        this.logger.error(
          {
            courseId,
            tenantId,
            err: err instanceof Error ? err.message : String(err),
          },
          'mod.ai-tutor: fallo al indexar curso publicado',
        );
        // No re-lanzar: el curso queda sin índice, pero la publicación NO
        // se debe revertir por un fallo de IA. El admin puede re-indexar
        // manualmente desde el panel cuando el problema (provider, cuota,
        // etc.) se resuelva.
      }
    });

    eventBus.subscribe<CourseUnpublishedEvent>('courses.course.unpublished', async (event) => {
      const tenantId = event.metadata.tenantId;
      const { courseId } = event.data;
      const indexer = this.registry.getAiTutorIndexerServiceOrNull();
      if (!indexer) return;
      try {
        await indexer.unindexCourse(tenantId, courseId);
      } catch (err) {
        this.logger.error(
          {
            courseId,
            tenantId,
            err: err instanceof Error ? err.message : String(err),
          },
          'mod.ai-tutor: fallo al desindexar',
        );
      }
    });

    // Una clase nueva (o una transcripción recién pegada) entra en el tutor sin
    // que nadie reindexe a mano. Antes sólo se indexaba al publicar el curso:
    // añadir un capítulo a un curso ya publicado no llegaba nunca al tutor.
    const reindexarLeccion = async (event: {
      metadata: { tenantId: string };
      data: LessonEvent;
    }) => {
      const tenantId = event.metadata.tenantId;
      const { lessonId } = event.data;
      const indexer = this.registry.getAiTutorIndexerServiceOrNull();
      if (!indexer) return;
      try {
        const r = await indexer.indexLesson(tenantId, lessonId);
        if (r.skipped) {
          this.logger.debug(
            { lessonId, tenantId, motivo: r.skipped },
            'mod.ai-tutor: lección no indexada',
          );
        }
      } catch (err) {
        // Igual que al publicar: un fallo de IA no puede tumbar el guardado de
        // la lección. Queda sin indexar y el admin puede reindexar a mano.
        this.logger.error(
          { lessonId, tenantId, err: err instanceof Error ? err.message : String(err) },
          'mod.ai-tutor: fallo al indexar lección',
        );
      }
    };

    eventBus.subscribe<LessonEvent>('courses.lesson.created', reindexarLeccion);
    eventBus.subscribe<LessonEvent>('courses.lesson.updated', reindexarLeccion);

    eventBus.subscribe<LessonEvent>('courses.lesson.deleted', async (event) => {
      const indexer = this.registry.getAiTutorIndexerServiceOrNull();
      if (!indexer) return;
      try {
        await indexer.unindexLesson(event.metadata.tenantId, event.data.lessonId);
      } catch (err) {
        this.logger.error(
          {
            lessonId: event.data.lessonId,
            err: err instanceof Error ? err.message : String(err),
          },
          'mod.ai-tutor: fallo al desindexar lección',
        );
      }
    });
  }
}
