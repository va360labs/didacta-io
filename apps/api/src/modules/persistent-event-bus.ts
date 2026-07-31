/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DomainEvent, EventBus, Logger } from '@didacta/core-kernel';
import type { PrismaService } from '../prisma/prisma.service';

type AnyEventHandler = (event: DomainEvent<unknown>) => Promise<void> | void;

/**
 * Adaptador opcional de despacho asíncrono. Si está presente y `isEnabled()`
 * devuelve true, `publish()` encola en lugar de despachar in-process. La
 * implementación real es `OutboxQueueService` con BullMQ + Redis.
 */
export interface OutboxDispatcher {
  isEnabled(): boolean;
  enqueue(outboxId: bigint): Promise<void>;
}

/**
 * EventBus persistente: aplica patrón Transactional Outbox.
 *
 * Flujo:
 *  1. publish() persiste el evento en `outbox_event` (idempotencyKey lo deduplica).
 *  2a. Si hay dispatcher async (BullMQ + Redis): encola un job con el outboxId.
 *      El worker (en este mismo proceso o en otro) llama processOutboxId(),
 *      que ejecuta los handlers locales y marca processed/failed. Reintentos
 *      exponenciales nativos de BullMQ.
 *  2b. Sin dispatcher (dev local sin Redis): despacha in-process inmediatamente.
 *      - Si todos los handlers OK → marca processed_at.
 *      - Si alguno falla → deja processed_at = null + incrementa attempts.
 *  3. OutboxRecoveryWorker (failsafe) reencola cada N min outbox rows que
 *     siguen pendientes (cobertura para Redis caído al momento de publish).
 *
 * La tabla outbox sigue siendo la única fuente de verdad — no se pierden
 * eventos ni con BullMQ ni sin él.
 */
export class PersistentEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<AnyEventHandler>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
    private readonly dispatcher?: OutboxDispatcher,
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

    if (this.dispatcher?.isEnabled()) {
      try {
        await this.dispatcher.enqueue(persisted.id);
        return;
      } catch (err) {
        // Si Redis falló al encolar, no perdemos el evento: la tabla outbox
        // tiene la fila con processedAt=null. El recovery worker lo reencola
        // en su próximo barrido. Mientras tanto, hacemos un fallback síncrono
        // para no perder despacho cuando Redis tiene un hiccup.
        this.logger.error('falló enqueue a BullMQ, fallback in-process', {
          outboxId: persisted.id.toString(),
          err: (err as Error).message,
        });
      }
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
   * Procesa un evento del outbox por su ID. Lo invoca el Worker BullMQ.
   * Idempotente: si la fila ya fue procesada, no hace nada.
   *
   * Lanza error si los handlers fallan, para que BullMQ aplique el backoff
   * exponencial y reintente. La fila outbox queda marcada con attempts +1.
   */
  async processOutboxId(outboxId: bigint): Promise<void> {
    const row = await this.prisma.outboxEvent.findUnique({
      where: { id: outboxId },
    });
    if (!row) {
      this.logger.warn('processOutboxId: fila no encontrada', {
        outboxId: outboxId.toString(),
      });
      return;
    }
    if (row.processedAt) {
      // Idempotencia: ya procesado.
      return;
    }
    const event: DomainEvent<unknown> = {
      name: row.eventName,
      version: row.payloadVersion,
      data: row.payload as unknown,
      metadata: row.metadata as unknown as DomainEvent['metadata'],
    };
    const ok = await this.runHandlers(row.id, event);
    if (!ok) {
      throw new Error(`outbox dispatch falló (id=${outboxId.toString()})`);
    }
  }

  /**
   * Reprocesa eventos pendientes (processedAt IS NULL). Llamado por el
   * OutboxRecoveryWorker al startup y en intervalos.
   *
   * Si hay dispatcher async habilitado, reencola los pendientes a la cola
   * (failsafe para casos de Redis caído al momento del publish original).
   * Sin dispatcher, los procesa in-process.
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
      if (this.dispatcher?.isEnabled()) {
        try {
          await this.dispatcher.enqueue(row.id);
          processed++;
        } catch (err) {
          failed++;
          this.logger.error('recovery: falló re-enqueue', {
            outboxId: row.id.toString(),
            err: (err as Error).message,
          });
        }
      } else {
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
    }

    if (pending.length > 0) {
      this.logger.info('outbox recovery batch', {
        size: pending.length,
        processed,
        failed,
        viaQueue: this.dispatcher?.isEnabled() ?? false,
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
