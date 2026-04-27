import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
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
 */
@Injectable()
export class OutboxRecoveryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly queue: OutboxQueueService,
    private readonly logger: PinoLogger,
    private readonly metrics: OutboxMetrics,
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
  }
}
