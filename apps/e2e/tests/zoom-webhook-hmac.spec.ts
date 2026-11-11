import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec G5.3: el webhook público de Zoom acepta solicitudes con firma HMAC
 * válida y aplica el cambio de status sobre `mod_zoom_live_session`.
 *
 * El webhook secret es per-tenant ahora (A2 de `work/migracion-env-a-panel.md`
 * — antes vivía en el env global `ZOOM_WEBHOOK_SECRET`). El test lo configura
 * él mismo vía el endpoint genérico de tenant-settings ANTES de firmar nada,
 * y lo borra al terminar. El webhook resuelve el tenant por `Host` header
 * (igual que `billing-public.controller.ts`); contra el stack de e2e eso
 * cae en `localhost`, que el seed/`setup/init` siembran siempre verificado.
 *
 * Flow:
 *   1. Admin configura `zoom-live/credentials.webhookSecret` (solo ese
 *      campo — sin accountId/clientId/clientSecret, así `buildZoomApiClient`
 *      sigue cayendo al stub y la creación de sesión no intenta pegarle a la
 *      API real de Zoom).
 *   2. Admin crea una sesión (status SCHEDULED).
 *   3. Construimos un payload `meeting.started` y lo firmamos con ese secret
 *      siguiendo el algoritmo de Zoom (HMAC-SHA256 sobre `v0:{timestamp}:{rawBody}`).
 *   4. POST al endpoint público `/api/v1/webhooks/zoom` (sin auth bearer).
 *   5. Verificamos `result=OK`.
 *   6. GET de la sesión confirma `status=STARTED`.
 *   7. Re-POST del mismo aviso → `result=DUPLICATE` (idempotencia). El cuerpo
 *      NO lleva `event_id` (Zoom no lo manda): la clave sale del contenido.
 *   8. POST con firma falsa → 401.
 *   9. Cleanup: borra `zoom-live/credentials`.
 */

/**
 * Firma como lo hace Zoom de verdad: `x-zm-request-timestamp` en SEGUNDOS
 * (10 dígitos). Firmar en ms —como hacía este helper— ocultaba que el
 * verificador comparaba segundos contra `Date.now()` y rechazaba todos los
 * webhooks reales.
 */
function signZoomWebhook(secret: string, body: string): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
  return { signature: `v0=${digest}`, timestamp };
}

test.describe('mod.zoom-live · webhook HMAC (G5.3)', () => {
  test('SCHEDULED → STARTED via webhook firmado, idempotente, rechaza firma falsa', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();
    const secret = `e2e-webhook-secret-${stamp}`;
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // 0. Configura el webhook secret de este tenant (solo ese campo — sin
    // accountId/clientId/clientSecret, para que la creación de sesión de
    // abajo siga usando el stub en vez de intentar Zoom real).
    const credsRes = await fetch(`${API_URL}/api/v1/tenant-settings/zoom-live/credentials`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ value: { webhookSecret: secret }, isSecret: true }),
    });
    expect(credsRes.ok, `set webhookSecret OK (got ${credsRes.status})`).toBe(true);

    // 1. Crear sesión Zoom (SCHEDULED).
    const createRes = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topic: `Webhook E2E ${stamp}`,
        // A punto de empezar: un `meeting.started` semanas antes de la clase
        // es una reunión abierta fuera de hora y se archiva sin aplicarse.
        startTime: new Date(Date.now() + 10 * 60_000).toISOString(),
        durationMinutes: 60,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'UTC',
      }),
    });
    expect(createRes.ok, `create OK (got ${createRes.status})`).toBe(true);
    const session = (await createRes.json()) as {
      id: string;
      status: string;
      zoomMeetingId: string | null;
    };
    expect(session.status).toBe('SCHEDULED');
    expect(session.zoomMeetingId).toBeTruthy();

    // 2. Payload meeting.started firmado, con la forma REAL de Zoom: sin
    // `event_id` en el cuerpo (no lo manda) y con `event_ts`. Mientras este
    // spec mandaba un `event_id` inventado, nadie vio que los avisos reales
    // se descartaban por no traerlo.
    const startedBody = JSON.stringify({
      event: 'meeting.started',
      event_ts: Date.now(),
      payload: {
        object: {
          id: session.zoomMeetingId,
          host_email: 'host@example.test',
        },
      },
    });
    const { signature, timestamp } = signZoomWebhook(secret, startedBody);

    // 3. POST al webhook público.
    const hookRes = await fetch(`${API_URL}/api/v1/webhooks/zoom`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zm-signature': signature,
        'x-zm-request-timestamp': timestamp,
      },
      body: startedBody,
    });
    expect(hookRes.ok, `webhook OK (got ${hookRes.status})`).toBe(true);
    const outcome = (await hookRes.json()) as { result: string; sessionId?: string };
    expect(outcome.result).toBe('OK');
    expect(outcome.sessionId).toBe(session.id);

    // 4. La sesión transicionó a STARTED.
    const after = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(after.ok).toBe(true);
    const detail = (await after.json()) as { status: string };
    expect(detail.status).toBe('STARTED');

    // 5. Idempotencia: la reentrega del MISMO aviso (mismo cuerpo) retorna
    // DUPLICATE sin re-aplicar. La clave sale del contenido, no de un id.
    const dupRes = await fetch(`${API_URL}/api/v1/webhooks/zoom`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zm-signature': signature,
        'x-zm-request-timestamp': timestamp,
      },
      body: startedBody,
    });
    expect(dupRes.ok).toBe(true);
    const dupOutcome = (await dupRes.json()) as { result: string };
    expect(dupOutcome.result).toBe('DUPLICATE');

    // 6. Firma incorrecta → 401.
    const fakeBody = JSON.stringify({
      event: 'meeting.ended',
      event_ts: Date.now(),
      payload: { object: { id: session.zoomMeetingId } },
    });
    const fakeRes = await fetch(`${API_URL}/api/v1/webhooks/zoom`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zm-signature': 'v0=000000000000000000000000000000000000000000000000000000000000dead',
        'x-zm-request-timestamp': String(Date.now()),
      },
      body: fakeBody,
    });
    expect(fakeRes.status).toBe(401);

    // 9. Cleanup: no dejar el webhook secret de prueba guardado.
    await fetch(`${API_URL}/api/v1/tenant-settings/zoom-live/credentials`, {
      method: 'DELETE',
      headers: adminHeaders,
    }).catch(() => {});
  });
});
