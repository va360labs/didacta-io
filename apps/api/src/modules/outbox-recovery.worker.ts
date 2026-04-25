import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleRegistryService } from './module-registry.service';

/**
 * Reprocesa eventos pendientes en outbox_event al arranque y periódicamente.
 *
 * Tras un crash o un fallo de handler, los eventos quedan con processedAt=null.
 * Este worker garantiza que se vuelvan a despachar cuando los handlers locales
 * estén disponibles.
 */
@Injectable()
export class OutboxRecoveryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private interval?: NodeJS.Timeout;
  private intervalMs = 30_000;

  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Primer barrido al arrancar.
    await this.runOnce();
    // Programado periódico.
    this.interval = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  private async runOnce(): Promise<void> {
    try {
      const result = await this.registry.recoverOutbox();
      if (result.processed > 0 || result.failed > 0) {
        this.logger.log(result, 'outbox recovery sweep');
      }
    } catch (error) {
      this.logger.error({ err: error }, 'outbox recovery sweep falló');
    }
  }
}
