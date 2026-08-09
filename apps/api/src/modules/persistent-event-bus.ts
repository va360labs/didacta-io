/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DomainEvent, EventBus, Logger } from '@didacta/core-kernel';
import type { PrismaService } from '../prisma/prisma.service';
import { runSanctionedGlobalAccess, tenantContextStorage } from '../tenancy/tenant-context.storage';

type AnyEventHandler = (event: DomainEvent<unknown>) => Promise<void> | void;

/**
 * Marca que el despacho de un evento NO llegó a ningún handler.
 *
 * Va en `outbox_event.last_error` porque es la única columna que distingue
 * un desenlace de otro sin migrar el esquema. Antes de esto un evento sin
 * subscribers se marcaba `processed_at` a secas: `processing_attempts=0`,
 * `last_error` NULL — es decir, EXACTAMENTE la misma fila que un evento
 * entregado con éxito. Perder un evento era indistinguible de procesarlo y,
 * como `recoverPending()` sólo mira `processed_at IS NULL`, irrecuperable.
 *
 * El prefijo (no el mensaje entero) es lo que se consulta: detrás va el
 * nombre del evento para poder agrupar en SQL sin joins.
 */
export const NO_HANDLER_ERROR_PREFIX = 'NO_HANDLER: ';

/**
 * Ventana en la que un evento no entregado sigue siendo elegible para
 * re-entrega automática (`replayUndelivered`). Acota el efecto de registrar
 * un bridge nuevo: se recuperan los eventos que ese bridge se perdió por una
 * carrera de arranque o un despliegue a medias, no la historia entera del
 * tenant desde el día uno.
 */
export const NO_HANDLER_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Desenlace de un intento de despacho. Es lo que devuelve `runHandlers` en
 * lugar del `boolean` anterior, que colapsaba «entregado» y «no había a quién
 * entregar» en el mismo `true`.
 *
 *   delivered   → ≥1 handler y todos terminaron OK.
 *   failed      → ≥1 handler y alguno lanzó. Reintentable.
 *   undelivered → 0 handlers. NO es un fallo (fan-out a cero es legítimo en un
 *                 bus), pero tampoco es un éxito: queda etiquetado y se
 *                 re-entrega solo si algún día aparece un subscriber.
 */
export type DispatchOutcome = 'delivered' | 'failed' | 'undelivered';

/** Forma mínima de una fila de `outbox_event` que el bus necesita rehidratar. */
interface OutboxRowLike {
  eventName: string;
  payloadVersion: number;
  payload: unknown;
  metadata: unknown;
}

/** Rehidrata el DomainEvent desde la fila persistida. */
function rowToEvent(row: OutboxRowLike): DomainEvent<unknown> {
  return {
    name: row.eventName,
    version: row.payloadVersion,
    data: row.payload,
    metadata: row.metadata as DomainEvent['metadata'],
  };
}

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
 * Observador opcional de despachos que no llegaron a nadie. Tipado
 * estructural (no la clase `OutboxMetrics`) para que el bus siga siendo
 * construible en tests con `new PersistentEventBus(prisma, logger)`.
 *
 * Va aquí y no en el sweep de recovery a propósito: en producción el 99% del
 * despacho pasa por el worker BullMQ (`processOutboxId`), así que contar sólo
 * desde el sweep dejaría la métrica casi siempre a cero.
 */
export interface UndeliveredObserver {
  recordUndelivered(): void;
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
 *     siguen pendientes (cobertura para Redis caído al momento de publish) y
 *     re-entrega los que no llegaron a ningún handler y ahora sí tienen uno.
 *
 * La tabla outbox sigue siendo la única fuente de verdad — no se pierden
 * eventos ni con BullMQ ni sin él.
 *
 * ── Los cuatro estados de una fila de `outbox_event` ────────────────────────
 *
 *  processed_at | last_error          | significado
 *  -------------|---------------------|--------------------------------------
 *  NOT NULL     | NULL                | entregado a ≥1 handler, todos OK
 *  NOT NULL     | 'NO_HANDLER: <ev>'  | NO llegó a nadie. Terminal pero
 *                                     | etiquetado y re-entregable en cuanto
 *                                     | exista un subscriber (replayUndelivered)
 *  NULL         | NULL                | pendiente: encolado, aún sin despachar
 *  NULL         | '<error>'           | falló el despacho. Reintentable
 *
 * El único estado ambiguo posible sería «processed_at puesto y last_error
 * viejo pegado» de un reintento que acabó bien: por eso `markProcessed()`
 * LIMPIA `last_error`. Sin esa limpieza la tabla de arriba no cerraría.
 */
export class PersistentEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<AnyEventHandler>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
    private readonly dispatcher?: OutboxDispatcher,
    private readonly undeliveredObserver?: UndeliveredObserver,
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
    // Lookup por id sin conocer aún el tenant: acceso global sancionado.
    const row = await runSanctionedGlobalAccess(() =>
      this.prisma.outboxEvent.findUnique({
        where: { id: outboxId },
      }),
    );
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
    const outcome = await this.runHandlers(row.id, rowToEvent(row));
    // Sólo `failed` propaga: es el único desenlace que un reintento puede
    // arreglar. `undelivered` ya quedó etiquetado en la fila y se recupera por
    // `replayUndelivered()`, no reintentando contra un set de handlers vacío.
    if (outcome === 'failed') {
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
  async recoverPending(
    limit = 50,
  ): Promise<{ processed: number; failed: number; undelivered: number }> {
    // Barrido cross-tenant de pendientes: acceso global sancionado.
    const pending = await runSanctionedGlobalAccess(() =>
      this.prisma.outboxEvent.findMany({
        where: { processedAt: null },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
    );

    let processed = 0;
    let failed = 0;
    let undelivered = 0;

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
        const outcome = await this.runHandlers(row.id, rowToEvent(row));
        if (outcome === 'delivered') processed++;
        else if (outcome === 'undelivered') undelivered++;
        else failed++;
      }
    }

    if (pending.length > 0) {
      this.logger.info('outbox recovery batch', {
        size: pending.length,
        processed,
        failed,
        undelivered,
        viaQueue: this.dispatcher?.isEnabled() ?? false,
      });
    }
    return { processed, failed, undelivered };
  }

  /**
   * Re-entrega los eventos que en su día NO llegaron a ningún handler y cuyo
   * nombre SÍ tiene subscribers ahora.
   *
   * Es la mitad «recuperable» del arreglo: sin esto, marcar el evento como no
   * entregado sólo dejaría una lápida legible. Los casos que recupera de
   * verdad son los que dejaban el evento perdido para siempre:
   *   - carrera de arranque (el evento se despachó antes de que el bridge
   *     llegara a `onModuleInit`);
   *   - despliegue a medias en el que el módulo consumidor subió después;
   *   - un bridge que se registró más tarde en la vida del proceso.
   *
   * Acotado por `NO_HANDLER_REPLAY_WINDOW_MS` y por `limit`: registrar un
   * bridge nuevo no puede desencadenar una re-entrega masiva de historia.
   */
  async replayUndelivered(limit = 50): Promise<{ replayed: number; failed: number }> {
    const subscribed = [...this.handlers.entries()]
      .filter(([, set]) => set.size > 0)
      .map(([name]) => name);
    if (subscribed.length === 0) return { replayed: 0, failed: 0 };

    const since = new Date(Date.now() - NO_HANDLER_REPLAY_WINDOW_MS);
    // Barrido cross-tenant: acceso global sancionado, igual que recoverPending.
    const rows = await runSanctionedGlobalAccess(() =>
      this.prisma.outboxEvent.findMany({
        where: {
          processedAt: { not: null },
          eventName: { in: subscribed },
          lastError: { startsWith: NO_HANDLER_ERROR_PREFIX },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
    );

    let replayed = 0;
    let failed = 0;

    for (const row of rows) {
      // Reabrir ANTES de despachar: si el proceso muere a mitad, la fila queda
      // pendiente (recuperable por recoverPending), nunca marcada como
      // entregada sin haberlo estado.
      await this.prisma.outboxEvent.update({
        where: { id: row.id },
        data: { processedAt: null, lastError: null },
      });
      const outcome = await this.runHandlers(row.id, rowToEvent(row));
      if (outcome === 'delivered') replayed++;
      else failed++;
    }

    if (rows.length > 0) {
      this.logger.info('outbox replay de eventos sin handler', {
        size: rows.length,
        replayed,
        failed,
      });
    }
    return { replayed, failed };
  }

  private async dispatchLocal<TPayload>(
    outboxId: bigint,
    event: DomainEvent<TPayload>,
  ): Promise<void> {
    await this.runHandlers(outboxId, event as DomainEvent<unknown>);
  }

  private async runHandlers(
    outboxId: bigint,
    event: DomainEvent<unknown>,
  ): Promise<DispatchOutcome> {
    // Contexto de tenant del EVENTO para todo el despacho: los handlers (y los
    // 17 bridges suscritos) ejecutan sus queries con la extensión RLS
    // escopando al tenant correcto, sin tocar cada bridge.
    const tenantId = event.metadata?.tenantId;
    if (tenantId) {
      return tenantContextStorage.run({ tenantId, traceId: `outbox-${outboxId.toString()}` }, () =>
        this.runHandlersInner(outboxId, event),
      );
    }
    return this.runHandlersInner(outboxId, event);
  }

  private async runHandlersInner(
    outboxId: bigint,
    event: DomainEvent<unknown>,
  ): Promise<DispatchOutcome> {
    const set = this.handlers.get(event.name);

    // RECUENTO DE HANDLERS EN EL DESPACHO. Cero subscribers no es un fallo
    // (un bus admite fan-out a cero por diseño) pero tampoco es una entrega:
    // se marca como tal para que quede rastro y para que `replayUndelivered`
    // pueda re-entregarlo si más adelante aparece quien lo escuche.
    //
    // No se lanza excepción a propósito: haría que BullMQ reintentara 5 veces
    // CADA evento sin consumidor — y hoy hay ~30 nombres de evento publicados
    // que legítimamente no tiene nadie suscrito (fundae.*, messaging.*,
    // courses.course.created…). Serían miles de reintentos inútiles por tanda.
    if (!set || set.size === 0) {
      await this.markUndelivered(outboxId, event.name);
      this.undeliveredObserver?.recordUndelivered();
      this.logger.warn('evento sin handlers: no se entregó a nadie', {
        event: event.name,
        outboxId: outboxId.toString(),
        tenantId: event.metadata?.tenantId,
      });
      return 'undelivered';
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
      return 'delivered';
    }

    await this.markFailed(outboxId, errors.join(' | '));
    return 'failed';
  }

  private async markProcessed(outboxId: bigint): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: outboxId },
      data: {
        processedAt: new Date(),
        // Limpiar el error es lo que hace que «processed_at puesto» + «sin
        // last_error» signifique EXACTAMENTE «entregado bien»: si un reintento
        // acaba en éxito, el error del intento anterior no puede quedarse
        // pegado o el estado NO_HANDLER dejaría de ser distinguible.
        lastError: null,
      },
    });
  }

  /**
   * Marca la fila como «no llegó a ningún handler». Terminal para el barrido
   * de pendientes (`processed_at` puesto: no se re-encola en bucle ni infla el
   * gauge de lag) pero explícitamente distinta de un éxito, y recuperable vía
   * `replayUndelivered()`.
   */
  private async markUndelivered(outboxId: bigint, eventName: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: outboxId },
      data: {
        processedAt: new Date(),
        lastError: `${NO_HANDLER_ERROR_PREFIX}${eventName}`.slice(0, 2000),
      },
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
