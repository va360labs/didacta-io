import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';

/**
 * Spec end-to-end de menciones (#159, #160, #163).
 *
 * Cubre:
 * - Usuario A crea post con `@<handleB>` en el body.
 * - El backend persiste la mención y notifica al usuario B.
 * - El usuario B llama `GET /modules/community/mentions/me` y ve la entrada.
 * - El endpoint de search `/users/search?prefix=` resuelve handles para
 *   el autocomplete.
 */
test.describe('mod.community · menciones end-to-end', () => {
  test('post con @handle persiste mención y aparece en /mentions/me del receptor', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();

    // Crear dos alumnos: A (autor) y B (mencionado).
    const handleB = `e2e-mention-b-${stamp}`;
    const userA = await signup({
      tenantSlug,
      email: `e2e-mention-a-${stamp}@example.test`,
      password: 'E2eMentionA123!',
      name: 'Alumno A',
    });
    const userB = await signup({
      tenantSlug,
      email: `${handleB}@example.test`,
      password: 'E2eMentionB123!',
      name: 'Alumno B',
    });

    // 1. A crea post mencionando a B.
    const created = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userA.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `Mención E2E ${stamp}`,
        body: `Hola @${handleB}, te necesito acá.`,
      }),
    });
    expect(created.ok, 'post se crea OK').toBe(true);

    // 2. B llama /mentions/me y ve la mención (buscamos por handle ya que
    //    runs paralelos pueden dejar otras menciones en la cuenta).
    const mineRes = await fetch(`${API_URL}/api/v1/modules/community/mentions/me`, {
      headers: { Authorization: `Bearer ${userB.tokens.accessToken}` },
    });
    expect(mineRes.ok).toBe(true);
    const mine = (await mineRes.json()) as Array<{
      mentionedHandle: string;
      authorId: string;
    }>;
    const found = mine.find((m) => m.mentionedHandle === handleB);
    expect(found, 'mención persistida y devuelta a B').toBeDefined();
    expect(found!.authorId).toBe(userA.user.id);
  });

  test('search/users resuelve por prefijo del handle', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const target = `e2e-search-target-${stamp}`;
    await signup({
      tenantSlug,
      email: `${target}@example.test`,
      password: 'E2eSearch123!',
      name: 'Search Target',
    });

    // Buscamos por un prefijo único — `e2e-search-target-${stamp}` no choca
    // con otros runs paralelos.
    const res = await fetch(
      `${API_URL}/api/v1/modules/community/users/search?prefix=${encodeURIComponent(target)}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.ok).toBe(true);
    const matches = (await res.json()) as Array<{ handle: string }>;
    expect(matches.some((m) => m.handle === target)).toBe(true);
  });
});
