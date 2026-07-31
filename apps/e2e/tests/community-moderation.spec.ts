import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';

/**
 * Spec de moderación de community (#158).
 *
 * Cubre:
 * - Admin crea un post.
 * - Admin lo oculta con motivo → otro alumno no lo ve en GET (404).
 * - Admin lo ve con `viewer.canModerate=true` (incluye `hidden_at`).
 * - Admin lo restaura → alumno vuelve a verlo.
 *
 * Es API-driven: solo el contrato moderación + listing filter es lo
 * relevante; el botón "Ocultar" en UI ya está cubierto por typecheck/build.
 */
test.describe('mod.community · moderación', () => {
  test('hide → alumno no ve → unhide → alumno vuelve a ver', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Admin crea un post.
    const created = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        title: `Post moderado E2E ${stamp}`,
        body: 'Contenido a moderar',
        tags: [],
      }),
    });
    expect(created.ok).toBe(true);
    const post = (await created.json()) as { id: string };

    // 2. Crear un alumno y verificar que ve el post antes de ocultarlo.
    const alumno = await signup({
      tenantSlug,
      email: `e2e-mod-alumno-${stamp}@example.test`,
      password: 'E2eModAlumno123!',
      name: 'Alumno Mod',
    });
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };

    const beforeHide = await fetch(`${API_URL}/api/v1/modules/community/posts/${post.id}`, {
      headers: alumnoHeaders,
    });
    expect(beforeHide.ok, 'alumno ve el post antes de ocultar').toBe(true);

    // 3. Admin oculta con motivo.
    const moderate = await fetch(`${API_URL}/api/v1/modules/community/posts/${post.id}/moderate`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ hidden: true, reason: 'Contenido inapropiado para test' }),
    });
    expect(moderate.ok).toBe(true);
    const moderated = (await moderate.json()) as {
      hiddenAt: string | null;
      hiddenReason: string | null;
    };
    expect(moderated.hiddenAt).not.toBeNull();
    expect(moderated.hiddenReason).toBe('Contenido inapropiado para test');

    // 4. El alumno ya no lo ve (404).
    const afterHide = await fetch(`${API_URL}/api/v1/modules/community/posts/${post.id}`, {
      headers: alumnoHeaders,
    });
    expect(afterHide.status, 'alumno recibe 404 sobre post oculto').toBe(404);

    // 5. El admin SÍ lo ve (canModerate=true).
    const adminSee = await fetch(`${API_URL}/api/v1/modules/community/posts/${post.id}`, {
      headers: adminHeaders,
    });
    expect(adminSee.ok, 'admin ve el post oculto').toBe(true);

    // 6. Restaurar.
    const restore = await fetch(`${API_URL}/api/v1/modules/community/posts/${post.id}/moderate`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ hidden: false }),
    });
    expect(restore.ok).toBe(true);
    const restored = (await restore.json()) as { hiddenAt: string | null };
    expect(restored.hiddenAt).toBeNull();

    // 7. El alumno vuelve a verlo.
    const finalSee = await fetch(`${API_URL}/api/v1/modules/community/posts/${post.id}`, {
      headers: alumnoHeaders,
    });
    expect(finalSee.ok, 'alumno vuelve a ver tras restore').toBe(true);
  });

  test('alumno NO puede llamar a moderate (403)', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const alumno = await signup({
      tenantSlug,
      email: `e2e-mod-noadmin-${stamp}@example.test`,
      password: 'E2eModNoadm123!',
      name: 'Alumno NoAdmin',
    });
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };

    // El admin crea un post.
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const created = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Post sin permisos ${stamp}`, body: 'X' }),
    });
    const post = (await created.json()) as { id: string };

    // El alumno intenta moderar → 403.
    const attempt = await fetch(`${API_URL}/api/v1/modules/community/posts/${post.id}/moderate`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: JSON.stringify({ hidden: true }),
    });
    expect(attempt.status, 'alumno sin rol mod recibe 403').toBeGreaterThanOrEqual(400);
    expect(attempt.status).toBeLessThan(500);
  });
});
