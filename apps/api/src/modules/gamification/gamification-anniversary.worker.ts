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
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant, runSanctionedGlobalAccess } from '../../tenancy/tenant-context.storage';
import { ModuleRegistryService } from '../module-registry.service';
import { GamificationRetentionBridge } from './gamification-retention.bridge';
import { GamificationRetentionHost } from './gamification-retention.host';

const QUEUE_NAME = 'didacta.gamification.anniversaries';
// Una vez al día, por la mañana en Europa (UTC). Configurable para pruebas.
const REPEAT_PATTERN = process.env['GAMIFICATION_ANNIVERSARY_CRON'] ?? '0 8 * * *';

type AnniversaryJobData = Record<string, never>;

/**
 * ¿Cumple hoy años en la comunidad? Mismo día y mes del alta, al menos un año
 * después. Quien se dio de alta un 29 de febrero lo celebra el 28 los años que
 * no son bisiestos (si no, no lo celebraría nunca).
 */
export function anniversaryYears(joinedAt: Date, today: Date): number | null {
  const years = today.getUTCFullYear() - joinedAt.getUTCFullYear();
  if (years < 1) return null;
  const jm = joinedAt.getUTCMonth();
  const jd = joinedAt.getUTCDate();
  const tm = today.getUTCMonth();
  const td = today.getUTCDate();
  if (jm === tm && jd === td) return years;
  const y = today.getUTCFullYear();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (jm === 1 && jd === 29 && !leap && tm === 1 && td === 28) return years;
  return null;
}

/**
 * Celebración diaria de los aniversarios de los miembros (activable por el
 * creador). Recorre las aulas con la gamificación activa y la celebración de
 * aniversarios encendida, y publica UN post por aula con todos los del día.
 */
@Injectable()
export class GamificationAnniversaryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<AnniversaryJobData>;
  private worker?: Worker<AnniversaryJobData>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    @Inject(forwardRef(() => ModuleRegistryService))
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly host: GamificationRetentionHost,
    private readonly bridge: GamificationRetentionBridge,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn('REDIS_URL no seteada — aniversarios de la comunidad sin programar');
      return;
    }
    if (process.env['NODE_ENV'] === 'test') return;

    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const conn: ConnectionOptions = this.connection;
    this.queue = new Queue<AnniversaryJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 30 * 24 * 3600, count: 50 },
        removeOnFail: { age: 30 * 24 * 3600, count: 50 },
      },
    });
    this.worker = new Worker<AnniversaryJobData>(QUEUE_NAME, async () => this.runFor(new Date()), {
      connection: this.workerConnection,
      concurrency: 1,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'aniversarios: el job falló');
    });
    await this.queue.add('daily', {} as AnniversaryJobData, {
      repeat: { pattern: REPEAT_PATTERN, tz: 'UTC' },
      jobId: 'daily-gamification-anniversaries',
    });
    this.logger.log(`aniversarios de la comunidad programados (cron='${REPEAT_PATTERN}' UTC)`);
  }

  /** Pasada de un día concreto. Pública para el disparo manual y los tests. */
  async runFor(
    today: Date,
    onlyTenantId?: string,
  ): Promise<{ tenants: number; celebrated: number }> {
    const tenants = onlyTenantId
      ? [onlyTenantId]
      : await runSanctionedGlobalAccess(async () =>
          (
            await this.prisma.modGamificationSettings.findMany({
              where: { celebrateAnniversaries: true },
              select: { tenantId: true },
            })
          ).map((r) => r.tenantId),
        );
    let celebrated = 0;
    for (const tenantId of tenants) {
      celebrated += await runAsTenant(tenantId, () => this.runTenant(tenantId, today), {
        traceLabel: 'gamification-anniversaries',
      });
    }
    return { tenants: tenants.length, celebrated };
  }

  private async runTenant(tenantId: string, today: Date): Promise<number> {
    if (!(await this.registry.isModuleEnabledForTenant(tenantId, 'mod.gamification'))) return 0;
    const settings = await this.registry.getGamificationRetentionService().getSettings(tenantId);
    if (!settings.celebrateAnniversaries) return 0;
    const yearAgo = new Date(today.getTime() - 364 * 86_400_000);
    const candidates = await this.prisma.user.findMany({
      where: { tenantId, deletedAt: null, status: 'ACTIVE', createdAt: { lt: yearAgo } },
      select: { id: true, createdAt: true },
      take: 20_000,
    });
    const due = candidates
      .map((u) => ({ id: u.id, years: anniversaryYears(u.createdAt, today) }))
      .filter((u): u is { id: string; years: number } => u.years !== null);
    if (due.length === 0) return 0;
    const members = await this.host.members(
      tenantId,
      due.map((u) => u.id),
    );
    let count = 0;
    for (const u of due) {
      const member = members.get(u.id);
      if (!member || member.isStaff) continue;
      await this.bridge.celebrateAnniversary(tenantId, {
        userId: u.id,
        name: member.name,
        years: u.years,
        year: today.getUTCFullYear(),
      });
      count += 1;
    }
    return count;
  }

  async onModuleDestroy(): Promise<void> {
    for (const close of [
      () => this.worker?.close(),
      () => this.queue?.close(),
      () => this.connection?.quit(),
      () => this.workerConnection?.quit(),
    ]) {
      try {
        await close();
      } catch {
        /* noop */
      }
    }
  }
}
