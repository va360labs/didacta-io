/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleContextFactory } from '../module-context.factory';

/**
 * Suscribe el NotificationHub a los eventos de negocio relevantes y dispara
 * notificaciones IN_APP (en v0.1; cuando exista SMTP también EMAIL) al
 * usuario destinatario.
 *
 * Este bridge centraliza la traducción evento → templateKey + variables, lo
 * que mantiene los emisores (mod.learning, mod.certificates, mod.assessments)
 * desacoplados del NotificationHub.
 *
 * Idempotencia: cada notificación crea un row distinto en `notification`. Si
 * el outbox reentrega un evento, se enviarán dos notificaciones IN_APP. Para
 * v0.1 es aceptable; en una iteración futura se puede dedupe por
 * (templateKey + idempotencyKey).
 */
@Injectable()
export class NotificationsBridge implements OnModuleInit {
  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Resuelve el nombre legible del curso a partir del courseId. Si la
   * lectura falla (curso borrado, problemas de permisos), cae al UUID
   * para que la notificación siga saliendo en lugar de tirar error.
   */
  private async resolveCourseLabel(tenantId: string, courseId: string): Promise<string> {
    try {
      const course = await this.prisma.modCoursesCourse.findFirst({
        where: { id: courseId, tenantId, deletedAt: null },
        select: { title: true },
      });
      return course?.title ?? courseId;
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e), tenantId, courseId },
        'NotificationsBridge: no pudimos resolver el título del curso, caemos al UUID',
      );
      return courseId;
    }
  }

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();
    const hub = this.factory.getNotificationHub();

    eventBus.subscribe<EnrollmentCreated>('learning.enrollment.created', async (e) => {
      const tenantId = e.metadata.tenantId;
      const { userId, courseId } = e.data;
      const courseLabel = await this.resolveCourseLabel(tenantId, courseId);
      await hub.send({
        tenantId,
        channel: 'in-app',
        templateKey: 'enrollment.created',
        to: userId,
        variables: { course: courseLabel, courseId },
      });
    });

    eventBus.subscribe<CourseCompleted>('learning.course.completed', async (e) => {
      const tenantId = e.metadata.tenantId;
      const { userId, courseId } = e.data;
      const courseLabel = await this.resolveCourseLabel(tenantId, courseId);
      await hub.send({
        tenantId,
        channel: 'in-app',
        templateKey: 'course.completed',
        to: userId,
        variables: { course: courseLabel, courseId },
      });
    });

    eventBus.subscribe<CertificateIssued>('certificates.issued', async (e) => {
      const tenantId = e.metadata.tenantId;
      const { userId, courseId, number } = e.data;
      const courseLabel = await this.resolveCourseLabel(tenantId, courseId);
      await hub.send({
        tenantId,
        channel: 'in-app',
        templateKey: 'certificate.issued',
        to: userId,
        variables: { course: courseLabel, number },
      });
    });

    eventBus.subscribe<AttemptOutcome>('assessments.attempt.passed', async (e) => {
      const tenantId = e.metadata.tenantId;
      const { userId, quizId, scorePercent } = e.data;
      await hub.send({
        tenantId,
        channel: 'in-app',
        templateKey: 'attempt.passed',
        to: userId,
        variables: { quiz: quizId, course: '', scorePercent },
      });
    });

    eventBus.subscribe<AttemptOutcome>('assessments.attempt.failed', async (e) => {
      const tenantId = e.metadata.tenantId;
      const { userId, quizId, scorePercent } = e.data;
      await hub.send({
        tenantId,
        channel: 'in-app',
        templateKey: 'attempt.failed',
        to: userId,
        variables: { quiz: quizId, scorePercent, passThreshold: 0 },
      });
    });

    eventBus.subscribe<AttemptOutcome>('assessments.attempt.graded', async (e) => {
      const tenantId = e.metadata.tenantId;
      const { userId, quizId, scorePercent, passed } = e.data;
      await hub.send({
        tenantId,
        channel: 'in-app',
        templateKey: 'attempt.graded',
        to: userId,
        variables: {
          quiz: quizId,
          scorePercent,
          result: passed ? 'aprobado' : 'no aprobado',
        },
      });
    });

    this.logger.log({}, 'NotificationsBridge: subscriptions registradas');
  }
}

interface EnrollmentCreated {
  userId: string;
  courseId: string;
  enrollmentId: string;
}

interface CourseCompleted {
  userId: string;
  courseId: string;
  enrollmentId: string;
}

interface CertificateIssued {
  userId: string;
  courseId: string;
  number: string;
}

interface AttemptOutcome {
  userId: string;
  quizId: string;
  scorePercent: number;
  passed: boolean;
}
