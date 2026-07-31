/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { SuperAdminPrismaService } from '../tenancy/super-admin-prisma.service';

const QUEUE_NAME = 'didacta.members.gdpr-purge';
const REPEAT_PATTERN = process.env['MEMBER_PURGE_CRON']?.trim() || '0 3 * * *'; // Diario 03:00 UTC

// El job no necesita parámetros: opera sobre todos los tenants, anonimizando los
// users de inscripción de miembros (PENDING/DEACTIVATED, sin decisión, con
// telegramId) cuyo createdAt supera la ventana de retención. Mantenemos la forma
// del data record para futura extensibilidad (filtros por tenant, dry-run, etc).
type MemberPurgeJobData = Record<string, never>;

/**
 * Worker BullMQ que ejecuta la purga GDPR de datos de Telegram de inscripciones
 * de miembros nunca aprobadas. Cada día a las 03:00 UTC (configurable vía
 * `MEMBER_PURGE_CRON`):
 *
 *  1. Calcula `cutoff = ahora - MEMBER_RETENTION_DAYS días` (default 90).
 *  2. Itera todos los tenants y, por cada uno (bajo `superAdmin.asAdmin`), busca
 *     users con `status ∈ (PENDING, DEACTIVATED)`, `approvalDecidedAt = null`,
 *     `telegramId != null` y `createdAt < cutoff`.
 *  3. Anonimiza esos users (`telegramId = null`, `telegramInGroup = null`). NO
 *     se borra el `audit_log` (la trazabilidad debe conservarse).
 *  4. Registra `member.gdpr.purged` por tenant con `metadata { count }`.
 *
 * Si REDIS_URL no está set, el worker no arranca (warn). En tests
 * (NODE_ENV=test) tampoco, para no romper bootstraps de Nest sin Redis.
 *
 * `triggerNow()` permite disparar el job sin esperar la cron — útil para QA.
 */
@Injectable()
export class MemberPurgeWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<MemberPurgeJobData>;
  private worker?: Worker<MemberPurgeJobData>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly superAdmin: SuperAdminPrismaService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn('REDIS_URL no seteada — member gdpr-purge scheduler no arranca');
      return;
    }
    if (process.env['NODE_ENV'] === 'test') return;

    this.connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const conn: ConnectionOptions = this.connection;

    this.queue = new Queue<MemberPurgeJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 30 * 24 * 3600, count: 50 },
        removeOnFail: { age: 30 * 24 * 3600, count: 50 },
      },
    });

    this.worker = new Worker<MemberPurgeJobData>(
      QUEUE_NAME,
      async () => {
        await this.processJob();
      },
      { connection: this.workerConnection, concurrency: 1 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'member gdpr-purge job falló');
    });

    // Repeatable: diario a las 03:00 UTC. BullMQ deduplica el repeat key con la
    // combinación (jobId base + pattern), así que rebootear no duplica.
    await this.queue.add('daily', {} as MemberPurgeJobData, {
      repeat: { pattern: REPEAT_PATTERN, tz: 'UTC' },
      jobId: 'daily-member-purge', // estable
    });

    this.logger.log(`member gdpr-purge scheduler activo (cron='${REPEAT_PATTERN}' UTC)`);
  }

  /**
   * Punto de entrada manual: encola un job inmediato. Si no hay Redis (tests,
   * bootstrap sin REDIS_URL), ejecuta in-process en modo degraded.
   */
  async triggerNow(): Promise<void> {
    if (!this.queue) {
      // Sin Redis → ejecución in-process. Mismo patrón que CommunityDigestWorker.
      await this.processJob();
      return;
    }
    await this.queue.add('daily-manual', {} as MemberPurgeJobData, {
      jobId: `manual-${Date.now()}`,
    });
  }

  /**
   * Lógica del job: itera todos los tenants y anonimiza los users de inscripción
   * nunca decididos cuyo createdAt supera la ventana de retención. Loguea el
   * resultado y audita por tenant.
   */
  private async processJob(): Promise<void> {
    const retentionDays = Number(process.env['MEMBER_RETENTION_DAYS'] ?? '90');
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);

    const startedAt = Date.now();
    try {
      const tenants = await this.prisma.tenant.findMany({ select: { id: true } });

      let totalPurged = 0;
      for (const { id: tenantId } of tenants) {
        const count = await this.superAdmin.asAdmin(tenantId, async (p) => {
          // Primero los ids exactos, para purgar user y perfil (dual-write D13)
          // con el MISMO criterio sin depender de un join.
          const targets = await p.user.findMany({
            where: {
              status: { in: ['PENDING', 'DEACTIVATED'] },
              approvalDecidedAt: null,
              telegramId: { not: null },
              createdAt: { lt: cutoff },
            },
            select: { id: true },
          });
          if (targets.length === 0) return 0;
          const ids = targets.map((t) => t.id);
          const result = await p.user.updateMany({
            where: { id: { in: ids } },
            data: {
              telegramId: null,
              telegramInGroup: null,
            },
          });
          await p.memberRegistrationProfile.updateMany({
            where: { tenantId, userId: { in: ids } },
            data: { telegramId: null, telegramInGroup: null },
          });
          return result.count;
        });

        if (count > 0) {
          totalPurged += count;
          // Auditoría por tenant. NO se borra el audit_log: la purga solo
          // anonimiza los datos de Telegram, la trazabilidad se conserva.
          await this.auditLog.record({
            tenantId,
            actorId: null,
            action: 'member.gdpr.purged',
            resourceType: 'user',
            resourceId: tenantId,
            metadata: { count },
          });
        }
      }

      const elapsedMs = Date.now() - startedAt;
      this.logger.log(
        { tenants: tenants.length, count: totalPurged, retentionDays, elapsedMs },
        'member gdpr-purge job completado',
      );
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'member gdpr-purge: la purga lanzó error',
      );
      throw err; // re-lanzamos para que BullMQ aplique retry exponencial
    }
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
