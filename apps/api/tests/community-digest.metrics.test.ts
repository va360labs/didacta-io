import { describe, expect, it, beforeEach } from 'vitest';
import { Counter, Histogram, Registry } from 'prom-client';
import { CommunityDigestMetrics } from '../src/modules/community-digest.metrics';

/**
 * Tests del facade `CommunityDigestMetrics`. Verificamos que cada método
 * delega correctamente en counters/histogram. Como prom-client es estático
 * a nivel de Registry, creamos uno aislado por test.
 */
function makeMetrics(): {
  metrics: CommunityDigestMetrics;
  registry: Registry;
  emails: Counter<'result'>;
  duration: Histogram<string>;
  users: Counter<string>;
} {
  const registry = new Registry();
  const emails = new Counter({
    name: 'community_digest_emails_total',
    help: 'test',
    labelNames: ['result'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'community_digest_run_duration_seconds',
    help: 'test',
    buckets: [0.1, 1, 10],
    registers: [registry],
  });
  const users = new Counter({
    name: 'community_digest_users_processed_total',
    help: 'test',
    registers: [registry],
  });
  // Construimos a mano para esquivar el DI de Nest.
  const metrics = new CommunityDigestMetrics(emails, duration, users);
  return { metrics, registry, emails, duration, users };
}

describe('CommunityDigestMetrics', () => {
  let setup: ReturnType<typeof makeMetrics>;

  beforeEach(() => {
    setup = makeMetrics();
  });

  it('recordSent incrementa con label result=sent', async () => {
    setup.metrics.recordSent();
    setup.metrics.recordSent();
    const value = await setup.emails.get();
    const sent = value.values.find((v) => v.labels.result === 'sent');
    expect(sent?.value).toBe(2);
  });

  it('recordSkipped y recordFailed usan labels distintas', async () => {
    setup.metrics.recordSkipped();
    setup.metrics.recordFailed();
    setup.metrics.recordFailed();
    const value = await setup.emails.get();
    const byLabel = Object.fromEntries(value.values.map((v) => [v.labels.result, v.value]));
    expect(byLabel['skipped']).toBe(1);
    expect(byLabel['failed']).toBe(2);
  });

  it('recordUserProcessed incrementa el contador de users', async () => {
    setup.metrics.recordUserProcessed();
    setup.metrics.recordUserProcessed();
    setup.metrics.recordUserProcessed();
    const value = await setup.users.get();
    expect(value.values[0]?.value).toBe(3);
  });

  it('startRunTimer devuelve un timer que mide la duración', async () => {
    const stop = setup.metrics.startRunTimer();
    // Mini sleep para que el histograma observe algo > 0.
    await new Promise((r) => setTimeout(r, 5));
    const elapsed = stop();
    expect(elapsed).toBeGreaterThan(0);
    const value = await setup.duration.get();
    // El histograma genera múltiples valores (buckets, sum, count).
    const count = value.values.find((v) => v.metricName?.endsWith('_count'));
    expect(count?.value).toBe(1);
  });

  it('todas las métricas son scrape-ables vía Registry.metrics()', async () => {
    setup.metrics.recordSent();
    setup.metrics.recordSkipped();
    setup.metrics.recordUserProcessed();
    const text = await setup.registry.metrics();
    expect(text).toContain('community_digest_emails_total');
    expect(text).toContain('community_digest_users_processed_total');
    expect(text).toContain('community_digest_run_duration_seconds');
    expect(text).toContain('result="sent"');
    expect(text).toContain('result="skipped"');
  });
});
