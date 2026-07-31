/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from './module-context.factory';
import { ModuleRegistryService } from './module-registry.service';

/**
 * Puente: cuando un alumno completa un paquete SCORM (cmi.core.lesson_status
 * o cmi.completion_status indican passed/completed), marcar la lección como
 * completada en mod.learning para disparar el flujo normal (progressPercent
 * → enrollment.COMPLETED → cert).
 *
 * Resuelve el `enrollmentId` consultando ModLearningEnrollment activo del
 * usuario en el curso al que pertenece la lección (vía mod_courses_lesson →
 * module → courseId).
 *
 * Idempotente: trackProgress hace upsert; reprocesar el mismo evento no
 * duplica progreso.
 */
interface ScormCompletedPayload {
  attemptId: string;
  lessonId: string;
  userId: string;
  packageId: string;
  completionStatus: string | null;
  scoreScaled: number | null;
}

@Injectable()
export class ScormLearningBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();
    eventBus.subscribe<ScormCompletedPayload>('scorm.attempt.completed', async (event) => {
      await this.handleCompleted(event);
    });
    this.logger.log({}, 'ScormLearningBridge: subscribed to scorm.attempt.completed');
  }

  async handleCompleted(event: DomainEvent<ScormCompletedPayload>): Promise<void> {
    const { lessonId, userId, attemptId, scoreScaled, completionStatus } = event.data;
    const tenantId = event.metadata.tenantId;
    const prisma = this.factory.getPrisma();

    const lesson = await prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: lessonId, deletedAt: null },
      include: { module: true },
    });
    if (!lesson) {
      this.logger.warn({ tenantId, lessonId, attemptId }, 'SCORM: lesson no encontrada');
      return;
    }
    const courseId = lesson.module.courseId;

    const enrollment = await prisma.modLearningEnrollment.findFirst({
      where: {
        tenantId,
        userId,
        courseId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
      },
    });
    if (!enrollment) {
      this.logger.warn(
        { tenantId, userId, courseId, lessonId, attemptId },
        'SCORM completed pero el alumno no tiene enrollment activo — ignoramos',
      );
      return;
    }

    try {
      await this.registry.getLearningService().trackProgress(tenantId, userId, {
        enrollmentId: enrollment.id,
        lessonId,
        watchedSeconds: 0,
        completed: true,
      });
      this.logger.log(
        { attemptId, lessonId, userId, tenantId, completionStatus, scoreScaled },
        'mod.learning: lección SCORM marcada como completada',
      );
    } catch (err) {
      this.logger.error(
        { err, attemptId, lessonId, userId, tenantId },
        'ScormLearningBridge falló al marcar lección como completada',
      );
      throw err;
    }
  }
}
