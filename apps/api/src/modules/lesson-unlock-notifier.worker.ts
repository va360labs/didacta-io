/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  forwardRef,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import type { NotificationValue } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { runAsTenant, runSanctionedGlobalAccess } from '../tenancy/tenant-context.storage';
import { ModuleContextFactory } from './module-context.factory';

const QUEUE_NAME = 'didacta.learning.lesson-unlock';
// Cada 10 min por defecto. Configurable vía env.
const REPEAT_PATTERN = process.env['LESSON_UNLOCK_CRON'] ?? '*/10 * * * *';

/** Relleno cuando el curso de la lección no se puede resolver. Lo traduce el hub. */
const UNKNOWN_COURSE_TITLE: NotificationValue = {
  hubValue: 'term',
  term: 'learning.course.unknown',
};

/**
 * Worker BullMQ que avisa a los alumnos suscritos cuando una clase programada
 * por fecha (`ModCoursesLesson.publishAt`) cruza su fecha de publicación
 * (MEJ-009). Cada tick:
 *
 *  1. Lee las suscripciones pendientes (`ModLearningLessonUnlockSub` con
 *     `notifiedAt` null).
 *  2. Filtra las cuya lección ya está publicada (`publishAt <= now`).
 *  3. Envía un aviso IN-APP (garantizado, visible en la campana) + EMAIL
 *     best-effort (si el tenant tiene SMTP), y marca `notifiedAt`.
 *
 * Como marca `notifiedAt` solo tras el envío in-app, las suscripciones creadas
 * ANTES de existir el worker se avisan retroactivamente en el primer tick.
 *
 * Sin `REDIS_URL` (o en tests) el worker no arranca. El envío se puede forzar
 * con `runNow()` (endpoint admin) sin esperar a la cron.
 */
@Injectable()
export class LessonUnlockNotifierWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue;
  private worker?: Worker;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ModuleContextFactory))
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn('REDIS_URL no seteada — lesson-unlock notifier no arranca');
      return;
    }
    if (process.env['NODE_ENV'] === 'test') return;

    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const conn: ConnectionOptions = this.connection;

    this.queue = new Queue(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600, count: 50 },
      },
    });

    this.worker = new Worker(
      QUEUE_NAME,
      async () => {
        await this.processDueUnlocks();
      },
      { connection: this.workerConnection, concurrency: 1 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'lesson-unlock job falló');
    });

    // Repeatable idempotente (jobId estable): rebootear no duplica.
    await this.queue.add(
      'tick',
      {},
      { repeat: { pattern: REPEAT_PATTERN }, jobId: 'lesson-unlock' },
    );
    this.logger.log(`lesson-unlock notifier activo (cron='${REPEAT_PATTERN}')`);
  }

  /** Fuerza un ciclo de envío (endpoint admin de QA). */
  async runNow(): Promise<{ sent: number; failed: number }> {
    return this.processDueUnlocks();
  }

  private async processDueUnlocks(): Promise<{ sent: number; failed: number }> {
    const now = new Date();
    // Barrido cross-tenant (inventario RLS F3): suscripciones pendientes de
    // todos los tenants + sus lecciones/módulos/cursos, de una pasada.
    const sweep = await runSanctionedGlobalAccess(async () => {
      const pending = await this.prisma.modLearningLessonUnlockSub.findMany({
        where: { notifiedAt: null },
        select: { id: true, tenantId: true, lessonId: true, userId: true },
        take: 500,
      });
      if (pending.length === 0) return null;

      // Lecciones ya publicadas (publishAt <= now) de entre las suscritas.
      const lessonIds = [...new Set(pending.map((s) => s.lessonId))];
      const lessons = await this.prisma.modCoursesLesson.findMany({
        where: { id: { in: lessonIds }, deletedAt: null, publishAt: { not: null, lte: now } },
        select: { id: true, title: true, moduleId: true },
      });
      if (lessons.length === 0) return null;

      // Título del curso de cada lección (módulo → curso).
      const moduleIds = [...new Set(lessons.map((l) => l.moduleId))];
      const mods = await this.prisma.modCoursesModule.findMany({
        where: { id: { in: moduleIds } },
        select: { id: true, courseId: true },
      });
      const courses = await this.prisma.modCoursesCourse.findMany({
        where: { id: { in: [...new Set(mods.map((m) => m.courseId))] } },
        select: { id: true, title: true },
      });
      return { pending, lessons, mods, courses };
    });
    if (!sweep) return { sent: 0, failed: 0 };

    const lessonById = new Map(sweep.lessons.map((l) => [l.id, l]));
    const courseIdByModule = new Map(sweep.mods.map((m) => [m.id, m.courseId]));
    const courseTitleById = new Map(sweep.courses.map((c) => [c.id, c.title]));

    const hub = this.factory.build().notificationHub;
    let sent = 0;
    let failed = 0;

    for (const sub of sweep.pending) {
      const lesson = lessonById.get(sub.lessonId);
      if (!lesson) continue; // su lección aún no está publicada
      const courseId = courseIdByModule.get(lesson.moduleId);
      // CAMINO DEGRADADO NOMBRADO: la lección existe pero su curso no se pudo
      // resolver (borrado entre el barrido y el aviso). El texto de relleno lo
      // pone el hub, que conoce el idioma del alumno: aquí estaba cableado «tu
      // curso» y se colaba en la frase inglesa de `lesson.unlocked`.
      const courseTitle: string | NotificationValue =
        (courseId && courseTitleById.get(courseId)) || UNKNOWN_COURSE_TITLE;
      const variables = { lessonTitle: lesson.title, courseTitle };
      try {
        // Procesado por fila bajo el tenant de la suscripción: la extensión
        // RLS escopa los envíos y el marcado de notifiedAt.
        await runAsTenant(sub.tenantId, async () => {
          // In-app garantizado.
          await hub.send({
            tenantId: sub.tenantId,
            channel: 'in-app',
            templateKey: 'lesson.unlocked',
            to: sub.userId,
            variables,
          });
          // Email best-effort (si el tenant tiene SMTP). No bloquea el marcado.
          try {
            await hub.send({
              tenantId: sub.tenantId,
              channel: 'email',
              templateKey: 'lesson.unlocked',
              to: sub.userId,
              variables,
            });
          } catch {
            /* sin SMTP o fallo de email: el in-app ya avisó */
          }
          await this.prisma.modLearningLessonUnlockSub.update({
            where: { id: sub.id },
            data: { notifiedAt: new Date() },
          });
        });
        sent++;
      } catch (err) {
        failed++;
        this.logger.warn(
          { subId: sub.id, err: err instanceof Error ? err.message : String(err) },
          'lesson-unlock: aviso falló',
        );
      }
    }

    if (sent || failed) this.logger.log({ sent, failed }, 'lesson-unlock: avisos procesados');
    return { sent, failed };
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.worker?.close();
    } catch {
      /* noop */
    }
    try {
      await this.queue?.close();
    } catch {
      /* noop */
    }
    try {
      await this.connection?.quit();
    } catch {
      /* noop */
    }
    try {
      await this.workerConnection?.quit();
    } catch {
      /* noop */
    }
  }
}
