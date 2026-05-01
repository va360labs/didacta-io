/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del WebhooksDispatcherEE — 10º piloto License SDK
 * (capability `feat:api.webhooks.high_throughput`).
 *
 * NOTA: NO levantamos BullMQ real en estos tests unit (eso queda para los
 * tests de integración con compose-test). Verificamos la lógica auxiliar
 * que no depende de Redis:
 *
 *   - signWebhookBody devuelve `sha256=<hex>` correcto y reproducible.
 *   - dispatch() lanza si la cola no está inicializada (REDIS_URL ausente
 *     o NODE_ENV=test). Esto asegura que el community service detecte el
 *     fallo y caiga al path naive.
 *
 * El behavior real BullMQ (encolado, retries, queue depth) se valida con
 * `apps/api/scripts` o tests de integración manualmente — fuera del scope
 * del unit test.
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

// Dynamic imports — evitamos el static import de un archivo `.ee.ts` desde un
// archivo no-EE (lo prohíbe ee-fence). Mismo patrón que
// branding-controllers.test.ts.
type DispatcherCtor = typeof import('../src/webhooks/webhooks.dispatcher.ee').WebhooksDispatcherEE;
type SignFn = typeof import('../src/webhooks/webhooks.dispatcher.ee').signWebhookBody;

async function loadDispatcher(): Promise<{
  WebhooksDispatcherEE: DispatcherCtor;
  signWebhookBody: SignFn;
}> {
  return import('../src/webhooks/webhooks.dispatcher.ee');
}

describe('signWebhookBody', () => {
  // El primer test paga el cold-start del dynamic import del dispatcher EE
  // (carga ioredis, bullmq, prom-client, etc.) — puede tardar >5s en CI/Windows.
  // Subimos timeout solo aquí; los siguientes tests reusan el módulo cacheado.
  it('produce sha256=<hex> reproducible', { timeout: 30000 }, async () => {
    const { signWebhookBody } = await loadDispatcher();
    const sig = signWebhookBody('secret-1234', '{"event":"test"}');
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);

    // Reproducible.
    const sig2 = signWebhookBody('secret-1234', '{"event":"test"}');
    expect(sig).toBe(sig2);
  });

  it('produce hash distinto al cambiar el secret', async () => {
    const { signWebhookBody } = await loadDispatcher();
    const a = signWebhookBody('secret-A', '{"x":1}');
    const b = signWebhookBody('secret-B', '{"x":1}');
    expect(a).not.toBe(b);
  });

  it('produce hash distinto al cambiar el body', async () => {
    const { signWebhookBody } = await loadDispatcher();
    const a = signWebhookBody('secret-1234', '{"x":1}');
    const b = signWebhookBody('secret-1234', '{"x":2}');
    expect(a).not.toBe(b);
  });

  it('coincide con HMAC-SHA256 manual con node:crypto', async () => {
    const { signWebhookBody } = await loadDispatcher();
    const secret = 'whsec_test';
    const body = '{"event":"learning.course.completed"}';
    const expected = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
    expect(signWebhookBody(secret, body)).toBe(expected);
  });
});

describe('WebhooksDispatcherEE.dispatch — sin Redis', () => {
  it('lanza si la cola no fue inicializada', async () => {
    const { WebhooksDispatcherEE } = await loadDispatcher();
    // Construimos sin pasar por bootstrap. Sin Redis la queue queda undefined
    // y dispatch() debe lanzar — esto es lo que detecta el community service
    // para hacer fallback naive.
    const fakePrisma = {
      webhookDeadLetter: { create: async () => ({}) },
    } as never;
    const fakeLogger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const fakeMetrics = {
      recordDelivery: () => {},
      recordDuration: () => {},
      recordAttempts: () => {},
      recordDeadLetter: () => {},
      setQueueDepth: () => {},
    };
    const dispatcher = new WebhooksDispatcherEE(
      fakePrisma,
      fakeLogger as never,
      fakeMetrics as never,
    );

    await expect(
      dispatcher.dispatch({
        tenantId: 't1',
        endpointId: 'e1',
        url: 'https://example.com',
        secret: 's',
        eventType: 'x',
        payload: {},
      }),
    ).rejects.toThrow(/no inicializado/);
    expect(dispatcher.isEnabled()).toBe(false);
  });
});
