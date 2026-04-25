import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@learnship/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from './module-context.factory';
import { ModuleRegistryService } from './module-registry.service';

/**
 * Puente cross-module: cuando un alumno pasa un quiz que estaba asociado a una
 * lección de tipo QUIZ, marcar esa lección como completada en mod.learning.
 *
 * Se suscribe a `assessments.attempt.passed`. Si el evento trae enrollmentId
 * y lessonId, llama a LearningService.trackProgress con completed=true. Si
 * faltan esos campos (intento ad-hoc fuera del contexto de un curso), no hace
 * nada — sigue siendo válido tener intentos no vinculados a una lección.
 *
 * Idempotente: trackProgress hace upsert sobre (enrollmentId, lessonId), así
 * que volver a procesar el mismo evento no duplica progreso ni revierte estado.
 */
interface AttemptPassedPayload {
  attemptId: string;
  quizId: string;
  userId: string;
  enrollmentId: string | null;
  lessonId: string | null;
  scoreEarned: number;
  scoreMax: number;
  scorePercent: number;
  passed: boolean;
}

@Injectable()
export class AssessmentsLearningBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();
    eventBus.subscribe<AttemptPassedPayload>('assessments.attempt.passed', async (event) => {
      await this.handleAttemptPassed(event);
    });
    this.logger.log({}, 'AssessmentsLearningBridge: subscribed to assessments.attempt.passed');
  }

  async handleAttemptPassed(event: DomainEvent<AttemptPassedPayload>): Promise<void> {
    const { enrollmentId, lessonId, userId, attemptId, quizId } = event.data;
    const tenantId = event.metadata.tenantId;

    if (!enrollmentId || !lessonId) {
      this.logger.debug(
        { attemptId, quizId, tenantId },
        'attempt.passed sin enrollmentId/lessonId — nada que enlazar',
      );
      return;
    }

    try {
      await this.registry.getLearningService().trackProgress(tenantId, userId, {
        enrollmentId,
        lessonId,
        watchedSeconds: 0,
        completed: true,
      });
      this.logger.log(
        { attemptId, quizId, enrollmentId, lessonId, userId, tenantId },
        'mod.assessments → mod.learning: QUIZ lesson marcada como completada',
      );
    } catch (err) {
      this.logger.error(
        { err, attemptId, quizId, enrollmentId, lessonId, userId, tenantId },
        'AssessmentsLearningBridge falló al marcar lección como completada',
      );
      throw err;
    }
  }
}
