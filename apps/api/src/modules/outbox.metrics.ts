/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import {
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';

/**
 * Métricas Prometheus del outbox dispatcher (BullMQ) y del recovery
 * worker (failsafe periódico).
 *
 * - `outbox_dispatch_total{result}` (counter): cada job de dispatch
 *   por resultado (`completed` | `failed`).
 * - `outbox_dispatch_duration_seconds` (histogram): duración de cada
 *   job de dispatch.
 * - `outbox_recovery_sweeps_total{result}` (counter): cada barrido
 *   del recovery worker (`success` | `error`).
 * - `outbox_recovery_events_total{result}` (counter): eventos recuperados
 *   por los sweeps (`processed` | `failed` | `deduplicated`).
 *   `deduplicated` es la etiqueta que hace visible el failsafe que no
 *   entrega: un re-enqueue que BullMQ descartó contra un job terminal. Antes
 *   iba sumado a `processed` y era indistinguible de una recuperación real.
 * - `outbox_enqueue_collisions_total{result}` (counter): encolados que
 *   chocaron con un job terminal ocupando el mismo `jobId` (`replaced` = se
 *   retiró el viejo y se reencoló; `swallowed` = no se pudo, el evento NO se
 *   despacha por la cola). Cualquier valor > 0 sostenido en `swallowed` es
 *   pérdida de despacho y merece alerta.
 * - `outbox_pending_oldest_age_seconds` (gauge): edad en segundos del
 *   evento `processedAt IS NULL` más viejo. 0 si no hay pendientes.
 *   Lo refresca el recovery worker en cada sweep — refleja un valor
 *   con staleness máxima de 5min en prod (intervalo del worker).
 * - `outbox_pending_events` (gauge): número de eventos pendientes en
 *   la última muestra del worker. 0 si no hay.
 * - `outbox_undelivered_total` (counter): eventos despachados que NO
 *   llegaron a ningún handler. Sin label de evento a propósito
 *   (cardinalidad): el nombre va en el WARN del bus y en `last_error`.
 *   Lo incrementa el propio bus, no el sweep, para que cuente también el
 *   camino BullMQ — que en producción es el 99% del tráfico.
 * - `outbox_replayed_total` (counter): eventos re-entregados por
 *   `replayUndelivered` cuando apareció un subscriber que antes faltaba.
 *
 * `outbox_undelivered_total` es lo que hace observable el fan-out a cero.
 * Antes un evento sin subscribers se marcaba procesado y no dejaba ni métrica
 * ni traza: era indistinguible de una entrega correcta.
 *
 * El dispatch counter cuenta TODOS los jobs (incluidos los que tienen
 * varios attempts), no solo los fallos terminales — útil para detectar
 * patrones de retry alto que el solo `failed` no captura.
 */
@Injectable()
export class OutboxMetrics {
  constructor(
    @InjectMetric('outbox_dispatch_total')
    private readonly dispatchCounter: Counter<'result'>,
    @InjectMetric('outbox_dispatch_duration_seconds')
    private readonly dispatchDuration: Histogram<string>,
    @InjectMetric('outbox_recovery_sweeps_total')
    private readonly sweepsCounter: Counter<'result'>,
    @InjectMetric('outbox_recovery_events_total')
    private readonly recoveryEventsCounter: Counter<'result'>,
    @InjectMetric('outbox_pending_oldest_age_seconds')
    private readonly oldestPendingAge: Gauge<string>,
    @InjectMetric('outbox_pending_events')
    private readonly pendingEvents: Gauge<string>,
    @InjectMetric('outbox_undelivered_total')
    private readonly undeliveredCounter: Counter<string>,
    @InjectMetric('outbox_replayed_total')
    private readonly replayedCounter: Counter<string>,
    @InjectMetric('outbox_enqueue_collisions_total')
    private readonly enqueueCollisionsCounter: Counter<'result'>,
  ) {}

  /**
   * Un encolado chocó con un job terminal que ocupaba el mismo `jobId`.
   * `replaced` = se retiró y se reencoló (el evento sí se despachará);
   * `swallowed` = BullMQ se lo tragó y no se pudo reemplazar.
   */
  recordEnqueueCollision(result: 'replaced' | 'swallowed'): void {
    this.enqueueCollisionsCounter.inc({ result });
  }

  /** Un evento se despachó y no había ningún handler suscrito. */
  recordUndelivered(): void {
    this.undeliveredCounter.inc();
  }

  /** Eventos re-entregados tras aparecer el subscriber que faltaba. */
  recordReplayed(count: number): void {
    if (count > 0) this.replayedCounter.inc(count);
  }

  recordDispatchCompleted(): void {
    this.dispatchCounter.inc({ result: 'completed' });
  }

  recordDispatchFailed(): void {
    this.dispatchCounter.inc({ result: 'failed' });
  }

  recordDispatchDuration(seconds: number): void {
    this.dispatchDuration.observe(seconds);
  }

  recordSweep(result: 'success' | 'error'): void {
    this.sweepsCounter.inc({ result });
  }

  recordRecoveryEvents(processed: number, failed: number, deduplicated = 0): void {
    if (processed > 0) this.recoveryEventsCounter.inc({ result: 'processed' }, processed);
    if (failed > 0) this.recoveryEventsCounter.inc({ result: 'failed' }, failed);
    if (deduplicated > 0) this.recoveryEventsCounter.inc({ result: 'deduplicated' }, deduplicated);
  }

  /**
   * Setea la edad en segundos del evento pendiente más viejo. El worker
   * de recovery la calcula como `(now - MIN(created_at WHERE processed_at IS NULL))`.
   * Pasar 0 si no hay pendientes.
   */
  setOldestPendingAgeSeconds(value: number): void {
    this.oldestPendingAge.set(value);
  }

  setPendingEventsCount(value: number): void {
    this.pendingEvents.set(value);
  }
}

export const outboxMetricsProviders = [
  makeCounterProvider({
    name: 'outbox_dispatch_total',
    help: 'Total de jobs de dispatch del outbox por resultado.',
    labelNames: ['result'],
  }),
  makeHistogramProvider({
    name: 'outbox_dispatch_duration_seconds',
    help: 'Duración (s) de cada job de dispatch del outbox.',
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30],
  }),
  makeCounterProvider({
    name: 'outbox_recovery_sweeps_total',
    help: 'Total de barridos del recovery worker por resultado.',
    labelNames: ['result'],
  }),
  makeCounterProvider({
    name: 'outbox_recovery_events_total',
    help: 'Total de eventos recuperados por sweeps del worker.',
    labelNames: ['result'],
  }),
  makeGaugeProvider({
    name: 'outbox_pending_oldest_age_seconds',
    help: 'Edad en segundos del evento `processed_at IS NULL` más viejo. 0 si no hay pendientes. Refrescado en cada sweep del recovery worker.',
  }),
  makeGaugeProvider({
    name: 'outbox_pending_events',
    help: 'Número de eventos `processed_at IS NULL` en la última muestra del recovery worker.',
  }),
  makeCounterProvider({
    name: 'outbox_undelivered_total',
    help: 'Total de eventos despachados que no encontraron ningún handler suscrito.',
  }),
  makeCounterProvider({
    name: 'outbox_replayed_total',
    help: 'Total de eventos re-entregados tras aparecer un subscriber que antes faltaba.',
  }),
  makeCounterProvider({
    name: 'outbox_enqueue_collisions_total',
    help: 'Encolados que chocaron con un job terminal bajo el mismo jobId (replaced = reencolado; swallowed = no despachado).',
    labelNames: ['result'],
  }),
];
