/**
 * Benchmark de latencia de la extensión de enforcement RLS (F1).
 *
 * El modo `warn` existe «para pagar el coste real, medirlo y llevar los huecos
 * a cero ANTES del flip» (header de rls-enforcement.extension.ts). Este test
 * MIDE ese coste contra Postgres real y lo imprime; NO impone presupuesto duro
 * (sigue sin fallar por umbral) — la decisión de producto (RLS decisión 6) ya
 * está cerrada: +5ms p95 como techo de alerta, con +1.2ms p50/+1.3ms p95
 * medidos en sesión 10 como dato real. Este benchmark existe para volver a
 * medir si el coste se desvía de ese rango en el futuro.
 *
 * Qué compara, con la misma query (`user.findFirst` filtrado por tenant):
 *  - baseline: cliente Prisma pelado (comportamiento RLS_ENFORCEMENT=off).
 *  - extension: cliente con la extensión y contexto ALS → cada query viaja en
 *    un `$transaction([set_config, query])` (dos round-trips en un batch).
 *
 * SKIP sin DATABASE_URL (mismo criterio que rls-isolation-didacta-app.integration.test.ts).
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTenantScopedModelSet,
  createRlsEnforcementExtension,
} from '../../src/prisma/rls-enforcement.extension';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const WARMUP = 20;
const ITERATIONS = 200;

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)]!;
}

async function measure(fn: () => Promise<unknown>): Promise<number[]> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return samples.sort((a, b) => a - b);
}

describeWithDb('RLS enforcement — benchmark de latencia (integration)', () => {
  let base: PrismaClient;
  let tenantId: string;
  let context: { tenantId: string } | undefined;
  let extended: PrismaClient;

  beforeAll(async () => {
    base = new PrismaClient();
    await base.$connect();
    const tenant = await base.tenant.create({
      data: { id: randomUUID(), slug: `bench-rls-${Date.now()}`, name: 'Bench RLS' },
    });
    tenantId = tenant.id;
    await base.user.create({
      data: {
        tenantId,
        email: `bench-${Date.now()}@example.com`,
        name: 'Bench',
        status: 'ACTIVE',
      },
    });

    extended = base.$extends(
      createRlsEnforcementExtension({
        mode: 'warn',
        getContext: () => context,
        tenantModels: buildTenantScopedModelSet(),
        onGap: () => {},
      }),
    ) as unknown as PrismaClient;
  });

  afterAll(async () => {
    context = undefined;
    if (tenantId) {
      await base.user.deleteMany({ where: { tenantId } });
      await base.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await base.$disconnect();
  });

  it('mide y reporta el overhead del wrap set_config+query', async () => {
    const query = (client: PrismaClient) =>
      client.user.findFirst({ where: { tenantId }, select: { id: true } });

    context = undefined;
    const baseline = await measure(() => query(base));

    context = { tenantId };
    const wrapped = await measure(() => query(extended));

    const report = {
      iterations: ITERATIONS,
      baseline: {
        p50: percentile(baseline, 50).toFixed(2),
        p95: percentile(baseline, 95).toFixed(2),
        p99: percentile(baseline, 99).toFixed(2),
      },
      extension: {
        p50: percentile(wrapped, 50).toFixed(2),
        p95: percentile(wrapped, 95).toFixed(2),
        p99: percentile(wrapped, 99).toFixed(2),
      },
      overheadP50Ms: (percentile(wrapped, 50) - percentile(baseline, 50)).toFixed(2),
      overheadP95Ms: (percentile(wrapped, 95) - percentile(baseline, 95)).toFixed(2),
    };
    // eslint-disable-next-line no-console -- el output ES el entregable del benchmark
    console.log('[rls-latency]', JSON.stringify(report));

    // Sanidad, no presupuesto: la query envuelta sigue devolviendo la fila.
    context = { tenantId };
    const row = await query(extended);
    expect(row?.id).toBeTruthy();
  }, 120_000);
});
