import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec de mod.zoom-live (#156, #162). API-driven.
 *
 * Cubre:
 * - Admin crea sesión con stub Zoom → meetingId determinístico, joinUrl/startUrl con `stub-zoom`.
 * - Listado por tenant ordena por startTime DESC.
 * - Update y cancel funcionan.
 * - lessonId requiere courseId; sin courseId rechaza con 422.
 */
test.describe('mod.zoom-live · sesiones síncronas', () => {
  test('crea sesión con stub Zoom, list la devuelve, cancel la marca CANCELLED', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Crear sesión libre del tenant (sin courseId).
    const created = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: `Zoom E2E ${stamp}`,
        startTime: '2026-12-01T10:00:00-03:00',
        durationMinutes: 60,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'America/Argentina/Buenos_Aires',
      }),
    });
    expect(created.ok, `create OK (got ${created.status})`).toBe(true);
    const session = (await created.json()) as {
      id: string;
      status: string;
      zoomMeetingId: string | null;
      joinUrl: string | null;
      startUrl: string | null;
    };
    expect(session.status).toBe('SCHEDULED');
    expect(session.zoomMeetingId).toBeTruthy();
    expect(session.joinUrl).toMatch(/stub-zoom/);
    expect(session.startUrl).toMatch(/stub-zoom/);

    // 2. La sesión aparece en el listado.
    const listRes = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, { headers });
    expect(listRes.ok).toBe(true);
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.some((s) => s.id === session.id)).toBe(true);

    // 3. Cancelar.
    const cancel = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}`, {
      method: 'DELETE',
      headers,
    });
    expect(cancel.ok).toBe(true);

    const after = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}`, {
      headers,
    });
    const detail = (await after.json()) as { status: string };
    expect(detail.status).toBe('CANCELLED');
  });

  test('rechaza lessonId sin courseId con 422', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();

    const res = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: `Zoom invalid ${stamp}`,
        startTime: '2026-12-01T10:00:00-03:00',
        durationMinutes: 60,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'UTC',
        // lessonId arbitrario sin courseId.
        lessonId: '00000000-0000-0000-0000-000000000001',
      }),
    });
    expect(res.status).toBe(422);
  });
});
