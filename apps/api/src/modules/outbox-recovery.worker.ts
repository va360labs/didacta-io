/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleRegistryService } from './module-registry.service';
import { OutboxMetrics } from './outbox.metrics';
import { OutboxQueueService } from './outbox-queue.service';

/**
 * Failsafe del outbox: reencola/reprocesa eventos pendientes (processedAt=null).
 *
 * Con BullMQ + Redis activos: el dispatcher principal corre on-publish, así que
 * este worker pasa a ser una red de seguridad para casos en que Redis estuvo
 * caído al momento de publish original. Intervalo: 5 min.
 *
 * Sin BullMQ (dev local sin Redis): mantiene el comportamiento original de
 * reprocesar in-process. Intervalo: 30 s para feedback rápido.
 *
 * Además del recovery, en cada sweep mide la **edad del evento pendiente más
 * viejo** y la cantidad de pendientes, y los expone como gauges en `/metrics`.
 * Esto permite alertar sobre lag (oldest > 5min) sin una alerta basada solo en
 * counters.
 */
@Injectable()
export class OutboxRecoveryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly queue: OutboxQueueService,
    private readonly logger: PinoLogger,
    private readonly metrics: OutboxMetrics,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Primer barrido al arrancar (cubre eventos quedados de un crash anterior).
    await this.runOnce();
    // Intervalo más laxo cuando BullMQ está activo: el dispatcher principal
    // corre on-publish, este es solo failsafe.
    const intervalMs = this.queue.isEnabled() ? 5 * 60_000 : 30_000;
    this.interval = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  /**
   * Mide la edad del evento pendiente más viejo y el total de pendientes.
   * Public para que el endpoint `/admin/system/health-detail` pueda
   * pedir un valor fresco sin esperar al próximo sweep.
   */
  async sampleLag(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const [pendingCount, oldest] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { processedAt: null } }),
      this.prisma.outboxEvent.findFirst({
        where: { processedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    const oldestAgeSeconds = oldest
      ? Math.max(0, Math.floor((Date.now() - oldest.createdAt.getTime()) / 1000))
      : 0;
    this.metrics.setPendingEventsCount(pendingCount);
    this.metrics.setOldestPendingAgeSeconds(oldestAgeSeconds);
    return { pending: pendingCount, oldestAgeSeconds };
  }

  private async runOnce(): Promise<void> {
    try {
      const result = await this.registry.recoverOutbox();
      this.metrics.recordSweep('success');
      this.metrics.recordRecoveryEvents(result.processed, result.failed);
      if (result.processed > 0 || result.failed > 0) {
        this.logger.log(result, 'outbox recovery sweep');
      }
    } catch (error) {
      this.metrics.recordSweep('error');
      this.logger.error({ err: error }, 'outbox recovery sweep falló');
    }

    // Siempre actualizamos los gauges, incluso si el sweep falló: nos interesa
    // saber el lag aunque el dispatcher esté roto.
    try {
      await this.sampleLag();
    } catch (error) {
      this.logger.warn({ err: error }, 'outbox lag sample falló');
    }
  }
}
