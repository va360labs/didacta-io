import type { DomainEvent, EventBus, Logger } from '@learnship/core-kernel';
import type { PrismaService } from '../prisma/prisma.service';

type AnyEventHandler = (event: DomainEvent<unknown>) => Promise<void> | void;

/**
 * EventBus persistente: aplica patrón Transactional Outbox.
 *
 * Flujo:
 *  1. publish() persiste el evento en `outbox_event` (idempotencyKey lo deduplica).
 *  2. Inmediatamente despacha a subscribers locales en el mismo proceso.
 *     - Si TODOS los handlers se ejecutan OK -> marca processed_at = now().
 *     - Si alguno falla -> deja processed_at = null + incrementa attempts + guarda lastError.
 *  3. OutboxRecoveryWorker (al startup y periódicamente) reprocesa pendientes.
 *
 * Cuando llegue Redis a la infra, se reemplaza el dispatch in-process por una
 * cola BullMQ sin tocar el contrato. La tabla outbox sigue siendo la única
 * fuente de verdad — no se pierden eventos.
 */
export class PersistentEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<AnyEventHandler>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
  ) {}

  async publish<TPayload>(event: DomainEvent<TPayload>): Promise<void> {
    const persisted = await this.prisma.outboxEvent.upsert({
      where: {
        tenantId_idempotencyKey: {
          tenantId: event.metadata.tenantId,
          idempotencyKey: event.metadata.idempotencyKey,
        },
      },
      create: {
        tenantId: event.metadata.tenantId,
        eventName: event.name,
        payloadVersion: event.version,
        payload: event.data as never,
        metadata: event.metadata as never,
        idempotencyKey: event.metadata.idempotencyKey,
      },
      update: {},
    });

    this.logger.info('event published to outbox', {
      event: event.name,
      tenantId: event.metadata.tenantId,
      outboxId: persisted.id.toString(),
    });

    if (persisted.processedAt) {
      // Reentrega del mismo evento -> ya se procesó. No re-despachar.
      return;
    }

    await this.dispatchLocal(persisted.id, event);
  }

  subscribe<TPayload>(
    eventName: string,
    handler: (event: DomainEvent<TPayload>) => Promise<void> | void,
  ): () => void {
    let set = this.handlers.get(eventName);
    if (!set) {
      set = new Set();
      this.handlers.set(eventName, set);
    }
    const wrapped = handler as AnyEventHandler;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  /**
   * Reprocesa eventos pendientes (processedAt IS NULL). Llamado por el
   * OutboxRecoveryWorker al startup y en intervalos.
   */
  async recoverPending(limit = 50): Promise<{ processed: number; failed: number }> {
    const pending = await this.prisma.outboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let processed = 0;
    let failed = 0;

    for (const row of pending) {
      const event: DomainEvent<unknown> = {
        name: row.eventName,
        version: row.payloadVersion,
        data: row.payload as unknown,
        metadata: row.metadata as unknown as DomainEvent['metadata'],
      };
      const ok = await this.runHandlers(row.id, event);
      if (ok) processed++;
      else failed++;
    }

    if (pending.length > 0) {
      this.logger.info('outbox recovery batch', {
        size: pending.length,
        processed,
        failed,
      });
    }
    return { processed, failed };
  }

  private async dispatchLocal<TPayload>(
    outboxId: bigint,
    event: DomainEvent<TPayload>,
  ): Promise<void> {
    await this.runHandlers(outboxId, event as DomainEvent<unknown>);
  }

  private async runHandlers(outboxId: bigint, event: DomainEvent<unknown>): Promise<boolean> {
    const set = this.handlers.get(event.name);
    if (!set || set.size === 0) {
      // Sin subscribers locales aún -> marcamos procesado igualmente.
      // Si más adelante se registra un handler, el evento ya fue al outbox y
      // puede inspeccionarse, pero no lo retransmitimos retroactivamente.
      await this.markProcessed(outboxId);
      return true;
    }

    const errors: string[] = [];
    for (const handler of set) {
      try {
        await handler(event);
      } catch (error) {
        const message = (error as Error).message;
        errors.push(`${(error as Error).name}: ${message}`);
        this.logger.error('event handler falló', {
          event: event.name,
          outboxId: outboxId.toString(),
          error: message,
        });
      }
    }

    if (errors.length === 0) {
      await this.markProcessed(outboxId);
      return true;
    }

    await this.markFailed(outboxId, errors.join(' | '));
    return false;
  }

  private async markProcessed(outboxId: bigint): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: outboxId },
      data: { processedAt: new Date() },
    });
  }

  private async markFailed(outboxId: bigint, lastError: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: outboxId },
      data: {
        processingAttempts: { increment: 1 },
        lastError: lastError.slice(0, 2000),
      },
    });
  }
}
