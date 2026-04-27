import { Injectable } from '@nestjs/common';
import { makeCounterProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Histogram } from 'prom-client';

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
];
