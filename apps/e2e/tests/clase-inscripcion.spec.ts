import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';

/**
 * Spec de inscripciones a clases en directo (ADR-017). API-driven, patrón
 * hermano de zoom-live.spec.ts (stub de Zoom, sin navegador).
 *
 * Cubre el requisito central: el `joinUrl` (y la grabación) SOLO se sirven a
 * miembros inscritos o staff — gating server-side, no ocultamiento de UI.
 */

interface SessionView {
  id: string;
  status: string;
  joinUrl: string | null;
  recordingUrl: string | null;
  registeredCount: number;
  isRegistered: boolean;
}

test.describe('mod.zoom-live · inscripción a clases en directo (ADR-017)', () => {
  test('gating end-to-end: sin inscribir no hay joinUrl; al inscribirse aparece; roster para admin', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Admin crea la clase (stub Zoom → joinUrl determinístico).
    const created = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        topic: `Clase E2E ${stamp}`,
        startTime: '2026-12-01T18:00:00+02:00',
        durationMinutes: 60,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'Europe/Madrid',
      }),
    });
    expect(created.ok, `create OK (got ${created.status})`).toBe(true);
    const session = (await created.json()) as SessionView;
    expect(session.joinUrl).toMatch(/stub-zoom/);

    // 2. Alumno sin rol staff.
    const alumno = await signup({
      tenantSlug,
      email: `e2e-clase-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Clase E2E',
    });
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };

    // 3. Sin inscribir: el detalle NO expone joinUrl ni grabación.
    const before = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}`, {
      headers: alumnoHeaders,
    });
    expect(before.ok).toBe(true);
    const beforeView = (await before.json()) as SessionView;
    expect(beforeView.isRegistered).toBe(false);
    expect(beforeView.joinUrl).toBeNull();
    expect(beforeView.recordingUrl).toBeNull();

    // ...y en el listado tampoco.
    const listRes = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      headers: alumnoHeaders,
    });
    const list = (await listRes.json()) as SessionView[];
    const inList = list.find((s) => s.id === session.id);
    expect(inList).toBeDefined();
    expect(inList!.joinUrl).toBeNull();

    // 4. Inscripción: idempotente y desbloquea el joinUrl.
    const reg = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/register`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: '{}',
    });
    expect(reg.ok, `register OK (got ${reg.status})`).toBe(true);
    const regView = (await reg.json()) as SessionView;
    expect(regView.isRegistered).toBe(true);
    expect(regView.registeredCount).toBe(1);
    expect(regView.joinUrl).toMatch(/stub-zoom/);

    const regAgain = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/register`,
      { method: 'POST', headers: alumnoHeaders, body: '{}' },
    );
    expect(regAgain.ok).toBe(true);
    expect(((await regAgain.json()) as SessionView).registeredCount).toBe(1);

    // 5. Roster para admin con la identidad del alumno; prohibido para el alumno.
    const roster = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/registrations`,
      { headers: adminHeaders },
    );
    expect(roster.ok).toBe(true);
    const rosterRows = (await roster.json()) as Array<{ userId: string; email: string }>;
    expect(rosterRows.some((r) => r.email === `e2e-clase-${stamp}@example.test`)).toBe(true);

    const rosterForbidden = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/registrations`,
      { headers: alumnoHeaders },
    );
    expect(rosterForbidden.status).toBe(401);

    // 6. Baja: el joinUrl vuelve a estar gateado.
    const unreg = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/unregister`,
      { method: 'POST', headers: alumnoHeaders, body: '{}' },
    );
    expect(unreg.ok).toBe(true);
    expect(((await unreg.json()) as { unregistered: boolean }).unregistered).toBe(true);

    const after = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}`, {
      headers: alumnoHeaders,
    });
    const afterView = (await after.json()) as SessionView;
    expect(afterView.isRegistered).toBe(false);
    expect(afterView.joinUrl).toBeNull();

    // 7. Clase cancelada → la inscripción responde 409.
    const cancel = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    expect(cancel.ok).toBe(true);
    const regCancelled = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/register`,
      { method: 'POST', headers: alumnoHeaders, body: '{}' },
    );
    expect(regCancelled.status).toBe(409);
  });
});
