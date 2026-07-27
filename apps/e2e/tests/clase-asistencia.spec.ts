import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, setupMfaAndVerify, signin, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Spec de asistencia real a clases en directo (ADR-018). API-driven, hermana
 * de clase-inscripcion.spec.ts.
 *
 * El requisito central que valida: la evidencia nunca miente. Un click en
 * "Unirme" cuenta como asistencia SOLO mientras no hemos podido preguntarle a
 * Zoom; en cuanto la sesión se reconcilia, manda Zoom. Como en E2E el cliente
 * de Zoom es el stub (que no devuelve participantes), la reconciliación deja
 * al alumno como ausente — exactamente lo que debe pasar cuando alguien abre
 * el enlace y no llega a entrar.
 */

/** Firma como Zoom: timestamp en SEGUNDOS sobre `v0:{ts}:{rawBody}`. */
function signZoomWebhook(secret: string, body: string): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
  return { signature: `v0=${digest}`, timestamp };
}

interface AttendanceRow {
  userId: string | null;
  email: string | null;
  registered: boolean;
  attended: boolean;
  confidence: 'ZOOM' | 'PROXY' | 'MANUAL' | 'NONE';
  minutes: number;
  clickedJoinAt: string | null;
  manualPresent: boolean | null;
}

interface AttendanceReport {
  sessionId: string;
  syncedAt: string | null;
  syncError: string | null;
  canSync: boolean;
  registeredCount: number;
  attendedCount: number;
  rows: AttendanceRow[];
}

test.describe('mod.zoom-live · asistencia real (ADR-018)', () => {
  test('proxy de entrada, gating, marcado manual y reconciliación con Zoom', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Admin crea la clase.
    const created = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        topic: `Asistencia E2E ${stamp}`,
        startTime: '2026-12-02T18:00:00+01:00',
        durationMinutes: 60,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'Europe/Madrid',
      }),
    });
    expect(created.ok, `create OK (got ${created.status})`).toBe(true);
    const session = (await created.json()) as { id: string; zoomMeetingId: string | null };

    const email = `e2e-asistencia-${stamp}@example.test`;
    const alumno = await signup({
      tenantSlug,
      email,
      password: 'E2eTestPassword123!',
      name: 'Alumno Asistencia E2E',
    });
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };

    // 2. Sin inscribirse, el proxy de entrada rechaza: mismo gating que el
    //    joinUrl, pero con un error explícito porque el usuario pulsó algo.
    const joinSinInscribir = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/join`,
      { method: 'POST', headers: alumnoHeaders, body: '{}' },
    );
    expect(joinSinInscribir.status).toBe(403);

    // 3. Inscripción + entrada: el proxy devuelve el enlace y sella el click.
    const reg = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/register`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: '{}',
    });
    expect(reg.ok, `register OK (got ${reg.status})`).toBe(true);

    const join = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/join`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: '{}',
    });
    expect(join.ok, `join OK (got ${join.status})`).toBe(true);
    expect(((await join.json()) as { joinUrl: string }).joinUrl).toMatch(/stub-zoom/);

    // 4. El informe es solo para staff.
    const forbidden = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/attendance`,
      { headers: alumnoHeaders },
    );
    expect(forbidden.status).toBe(401);

    // 5. Antes de reconciliar, el click cuenta — pero declarado como PROXY.
    const beforeRes = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/attendance`,
      { headers: adminHeaders },
    );
    expect(beforeRes.ok).toBe(true);
    const before = (await beforeRes.json()) as AttendanceReport;
    expect(before.syncedAt).toBeNull();
    expect(before.registeredCount).toBe(1);
    expect(before.attendedCount).toBe(1);

    const rowBefore = before.rows.find((r) => r.email === email)!;
    expect(rowBefore).toBeDefined();
    expect(rowBefore.registered).toBe(true);
    expect(rowBefore.attended).toBe(true);
    expect(rowBefore.confidence).toBe('PROXY');
    expect(rowBefore.clickedJoinAt).not.toBeNull();

    // 6. Marcado manual del formador: pisa el cálculo y se revierte.
    const markRes = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/attendance/${alumno.user.id}`,
      { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ present: false }) },
    );
    expect(markRes.ok, `mark OK (got ${markRes.status})`).toBe(true);
    const marked = (await markRes.json()) as AttendanceReport;
    const rowMarked = marked.rows.find((r) => r.email === email)!;
    expect(rowMarked.attended).toBe(false);
    expect(rowMarked.confidence).toBe('MANUAL');
    expect(rowMarked.manualPresent).toBe(false);

    const revertRes = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/attendance/${alumno.user.id}`,
      { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ present: null }) },
    );
    expect(revertRes.ok).toBe(true);
    const reverted = (await revertRes.json()) as AttendanceReport;
    const rowReverted = reverted.rows.find((r) => r.email === email)!;
    expect(rowReverted.attended).toBe(true); // vuelve al PROXY
    expect(rowReverted.confidence).toBe('PROXY');

    // 7. No se puede reconciliar una clase que no ha empezado.
    const tooEarly = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/attendance/sync`,
      { method: 'POST', headers: adminHeaders, body: '{}' },
    );
    expect(tooEarly.status).toBe(409);

    // 8. Con el webhook de Zoom disponible, cerramos la clase y reconciliamos.
    const secret = process.env.E2E_ZOOM_WEBHOOK_SECRET;
    if (!secret) {
      test.info().annotations.push({
        type: 'skip-parcial',
        description: 'Sin E2E_ZOOM_WEBHOOK_SECRET no se valida la reconciliación con Zoom.',
      });
      return;
    }

    const endedBody = JSON.stringify({
      event_id: `evt-asistencia-${stamp}-ended`,
      event: 'meeting.ended',
      payload: {
        object: { id: session.zoomMeetingId, uuid: `uuid-asistencia-${stamp}==` },
      },
    });
    const { signature, timestamp } = signZoomWebhook(secret, endedBody);
    const hook = await fetch(`${API_URL}/api/v1/webhooks/zoom`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zm-signature': signature,
        'x-zm-request-timestamp': timestamp,
      },
      body: endedBody,
    });
    expect(hook.ok, `webhook OK (got ${hook.status})`).toBe(true);
    expect(((await hook.json()) as { result: string }).result).toBe('OK');

    const syncRes = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/attendance/sync`,
      { method: 'POST', headers: adminHeaders, body: '{}' },
    );
    expect(syncRes.ok, `sync OK (got ${syncRes.status})`).toBe(true);
    const synced = (await syncRes.json()) as AttendanceReport;
    expect(synced.syncedAt).not.toBeNull();
    expect(synced.syncError).toBeNull();

    // El stub de Zoom no reporta participantes: el click deja de valer como
    // asistencia y la fila pasa a ser una ausencia confirmada. La evidencia
    // del click NO se destruye.
    const rowAfter = synced.rows.find((r) => r.email === email)!;
    expect(rowAfter.attended).toBe(false);
    expect(rowAfter.confidence).toBe('ZOOM');
    expect(rowAfter.clickedJoinAt).not.toBeNull();
    expect(synced.attendedCount).toBe(0);
  });

  test('el panel de asistencia se renderiza en /clase/[id] para staff', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminEmail = process.env.E2E_ADMIN_EMAIL;
    const adminPassword = process.env.E2E_ADMIN_PASSWORD;
    expect(adminEmail && adminPassword, 'E2E_ADMIN_EMAIL/PASSWORD requeridos').toBeTruthy();

    // Sesión de admin completa (no solo el token): la UI necesita el user.
    const adminSession = await signin({
      tenantSlug,
      email: adminEmail!,
      password: adminPassword!,
    });
    let adminToken = adminSession.tokens.accessToken;
    if (adminSession.mfaRequired) {
      adminToken = (await setupMfaAndVerify(adminToken)).accessToken;
    }
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    const created = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        topic: `Asistencia UI ${stamp}`,
        startTime: '2026-12-03T18:00:00+01:00',
        durationMinutes: 60,
        hostEmail: adminEmail,
        timezone: 'Europe/Madrid',
      }),
    });
    expect(created.ok, `create OK (got ${created.status})`).toBe(true);
    const session = (await created.json()) as { id: string };

    // Un alumno inscrito que además pulsa "Unirme": el panel tiene que
    // mostrarlo como asistente (evidencia PROXY).
    const alumno = await signup({
      tenantSlug,
      email: `e2e-asistencia-ui-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: `Alumno UI ${stamp}`,
    });
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };
    await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/register`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: '{}',
    });
    await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/join`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: '{}',
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: adminToken,
      refreshToken: adminSession.tokens.refreshToken,
      user: { ...adminSession.user, onboardingCompletedAt: new Date().toISOString() },
    });

    await page.goto(`/clase/${session.id}`);
    await expect(page.getByRole('heading', { name: `Asistencia UI ${stamp}` })).toBeVisible();

    // El panel solo existe en esta página, así que no hace falta acotarlo.
    await expect(page.getByRole('heading', { name: 'Asistencia', exact: true })).toBeVisible();
    await expect(page.getByText('1 de 1 inscrito')).toBeVisible();
    await expect(page.getByText('sin sincronizar con Zoom')).toBeVisible();
    await expect(page.getByText(`Alumno UI ${stamp}`)).toBeVisible();
    await expect(page.getByText('Asistió', { exact: true })).toBeVisible();

    // El marcado manual funciona desde la UI y el badge cambia.
    await page.getByRole('button', { name: 'Marcar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Presente', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Presente', exact: true }).click();
    await expect(page.getByText('No asistió', { exact: true })).toBeVisible();
  });
});
