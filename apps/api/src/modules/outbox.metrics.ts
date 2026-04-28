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
 *   por los sweeps (`processed` | `failed`).
 * - `outbox_pending_oldest_age_seconds` (gauge): edad en segundos del
 *   evento `processedAt IS NULL` más viejo. 0 si no hay pendientes.
 *   Lo refresca el recovery worker en cada sweep — refleja un valor
 *   con staleness máxima de 5min en prod (intervalo del worker).
 * - `outbox_pending_events` (gauge): número de eventos pendientes en
 *   la última muestra del worker. 0 si no hay.
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
  ) {}

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

  recordRecoveryEvents(processed: number, failed: number): void {
    if (processed > 0) this.recoveryEventsCounter.inc({ result: 'processed' }, processed);
    if (failed > 0) this.recoveryEventsCounter.inc({ result: 'failed' }, failed);
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
];
