import { describe, expect, it, beforeEach } from 'vitest';
import { Counter, Histogram, Registry } from 'prom-client';
import { OutboxMetrics } from '../src/modules/outbox.metrics';

function makeMetrics(): {
  metrics: OutboxMetrics;
  registry: Registry;
  dispatch: Counter<'result'>;
  duration: Histogram<string>;
  sweeps: Counter<'result'>;
  events: Counter<'result'>;
} {
  const registry = new Registry();
  const dispatch = new Counter({
    name: 'outbox_dispatch_total',
    help: 't',
    labelNames: ['result'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'outbox_dispatch_duration_seconds',
    help: 't',
    buckets: [0.01, 0.1, 1],
    registers: [registry],
  });
  const sweeps = new Counter({
    name: 'outbox_recovery_sweeps_total',
    help: 't',
    labelNames: ['result'],
    registers: [registry],
  });
  const events = new Counter({
    name: 'outbox_recovery_events_total',
    help: 't',
    labelNames: ['result'],
    registers: [registry],
  });
  const metrics = new OutboxMetrics(dispatch, duration, sweeps, events);
  return { metrics, registry, dispatch, duration, sweeps, events };
}

describe('OutboxMetrics', () => {
  let setup: ReturnType<typeof makeMetrics>;
  beforeEach(() => {
    setup = makeMetrics();
  });

  it('recordDispatchCompleted/Failed usa labels distintas', async () => {
    setup.metrics.recordDispatchCompleted();
    setup.metrics.recordDispatchCompleted();
    setup.metrics.recordDispatchFailed();
    const value = await setup.dispatch.get();
    const byLabel = Object.fromEntries(value.values.map((v) => [v.labels.result, v.value]));
    expect(byLabel['completed']).toBe(2);
    expect(byLabel['failed']).toBe(1);
  });

  it('recordDispatchDuration registra observación en histograma', async () => {
    setup.metrics.recordDispatchDuration(0.05);
    setup.metrics.recordDispatchDuration(0.5);
    const value = await setup.duration.get();
    const count = value.values.find((v) => v.metricName?.endsWith('_count'));
    const sum = value.values.find((v) => v.metricName?.endsWith('_sum'));
    expect(count?.value).toBe(2);
    expect(sum?.value).toBeCloseTo(0.55, 5);
  });

  it('recordSweep distingue success/error', async () => {
    setup.metrics.recordSweep('success');
    setup.metrics.recordSweep('success');
    setup.metrics.recordSweep('error');
    const value = await setup.sweeps.get();
    const byLabel = Object.fromEntries(value.values.map((v) => [v.labels.result, v.value]));
    expect(byLabel['success']).toBe(2);
    expect(byLabel['error']).toBe(1);
  });

  it('recordRecoveryEvents incrementa por cantidad y solo si > 0', async () => {
    setup.metrics.recordRecoveryEvents(3, 1);
    setup.metrics.recordRecoveryEvents(0, 0); // no debe crear filas
    setup.metrics.recordRecoveryEvents(2, 0);
    const value = await setup.events.get();
    const byLabel = Object.fromEntries(value.values.map((v) => [v.labels.result, v.value]));
    expect(byLabel['processed']).toBe(5);
    expect(byLabel['failed']).toBe(1);
  });

  it('todas las métricas son scrape-ables', async () => {
    setup.metrics.recordDispatchCompleted();
    setup.metrics.recordSweep('success');
    setup.metrics.recordRecoveryEvents(1, 0);
    setup.metrics.recordDispatchDuration(0.02);
    const text = await setup.registry.metrics();
    expect(text).toContain('outbox_dispatch_total');
    expect(text).toContain('outbox_dispatch_duration_seconds');
    expect(text).toContain('outbox_recovery_sweeps_total');
    expect(text).toContain('outbox_recovery_events_total');
    expect(text).toContain('result="completed"');
    expect(text).toContain('result="success"');
  });
});
