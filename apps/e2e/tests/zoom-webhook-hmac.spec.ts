import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec G5.3: el webhook público de Zoom acepta solicitudes con firma HMAC
 * válida y aplica el cambio de status sobre `mod_zoom_live_session`.
 *
 * Flow:
 *   1. Admin crea una sesión (status SCHEDULED).
 *   2. Construimos un payload `meeting.started` y lo firmamos con
 *      `ZOOM_WEBHOOK_SECRET` siguiendo el algoritmo de Zoom
 *      (HMAC-SHA256 sobre `v0:{timestamp}:{rawBody}`).
 *   3. POST al endpoint público `/api/v1/webhooks/zoom` (sin auth bearer).
 *   4. Verificamos `result=OK`.
 *   5. GET de la sesión confirma `status=STARTED`.
 *   6. Re-POST del mismo `event_id` → `result=DUPLICATE` (idempotencia).
 *   7. POST con firma falsa → 401.
 *
 * Requiere `E2E_ZOOM_WEBHOOK_SECRET` para que coincida con el del backend.
 * Si no está set, el test queda skip-en-el-acto.
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
    const secret = process.env.E2E_ZOOM_WEBHOOK_SECRET;
    if (!secret) {
      test.skip(
        true,
        'E2E_ZOOM_WEBHOOK_SECRET no está set (debe coincidir con ZOOM_WEBHOOK_SECRET del backend).',
      );
      return;
    }

    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();

    // 1. Crear sesión Zoom (SCHEDULED).
    const createRes = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topic: `Webhook E2E ${stamp}`,
        startTime: '2026-12-15T10:00:00-03:00',
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

    // 2. Payload meeting.started firmado.
    const eventId = `evt-${stamp}-started`;
    const startedBody = JSON.stringify({
      event_id: eventId,
      event: 'meeting.started',
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

    // 5. Idempotencia: el mismo event_id retorna DUPLICATE sin re-aplicar.
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
      event_id: `evt-${stamp}-fake`,
      event: 'meeting.ended',
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
  });
});
