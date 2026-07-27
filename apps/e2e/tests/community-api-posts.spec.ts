/**
 * E2E de la publicación en la comunidad vía API key (`POST /community-api/posts`):
 *
 *  1. El admin crea una API key con scope `community:post` (sin tokens que caducan).
 *  2. Publica por API → el post nace firmado por el DUEÑO de la key, con
 *     `source='api'`, y aparece en el feed de la comunidad.
 *  3. Una key sin el scope recibe 403 (contrato de scopes).
 *  4. Auditoría en el admin: /admin/comunidad/publicaciones-api lista el post
 *     agrupado por usuario, y /admin/integraciones/api documenta el endpoint.
 */

import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, createTenantApiKey, signin } from '../helpers/api';
import { injectSession } from '../helpers/auth';

const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'va360';

test.describe('Comunidad — publicación por API key', () => {
  test('publicar con key, contrato de scopes y auditoría en el admin', async ({ page }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);

    // ── 1. Key con el scope de comunidad (y otra SIN él, para el 403) ──
    const goodKey = await createTenantApiKey({
      bearer: adminToken,
      name: `e2e-community-${stamp}`,
      scopes: ['community:post'],
    });
    expect(goodKey.token).toMatch(/^lmsk_/);
    const wrongKey = await createTenantApiKey({
      bearer: adminToken,
      name: `e2e-wrong-scope-${stamp}`,
      scopes: ['enrollments:write'],
    });

    // ── 2. Publicar por API → post firmado por el dueño de la key ──
    const title = `Post por API E2E ${stamp}`;
    const created = await fetch(`${API_URL}/api/v1/community-api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${goodKey.token}`,
      },
      body: JSON.stringify({
        title,
        body: 'Publicado desde una integración externa (spec E2E).',
        tags: ['general'],
      }),
    });
    expect(created.status, 'POST /community-api/posts').toBe(201);
    const post = (await created.json()) as {
      id: string;
      title: string;
      source: string;
      authorId: string;
    };
    expect(post.source).toBe('api');

    // El post está en el feed y el filtro source=api lo encuentra.
    const feed = await fetch(`${API_URL}/api/v1/modules/community/posts?source=api&limit=100`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(feed.status).toBe(200);
    const apiPosts = (await feed.json()) as Array<{ id: string; source: string }>;
    expect(apiPosts.some((p) => p.id === post.id)).toBe(true);
    expect(apiPosts.every((p) => p.source === 'api')).toBe(true);

    // ── 3. Key sin scope → 403 ──
    const forbidden = await fetch(`${API_URL}/api/v1/community-api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${wrongKey.token}`,
      },
      body: JSON.stringify({ title: 'No debería entrar', body: 'x' }),
    });
    expect(forbidden.status, 'key sin community:post').toBe(403);

    // ── 4. Auditoría en el admin (UI) ──
    const session = await signin({
      tenantSlug: TENANT_SLUG,
      email: process.env.E2E_ADMIN_EMAIL!,
      password: process.env.E2E_ADMIN_PASSWORD!,
    });
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: adminToken,
      user: {
        id: session.user.id,
        email: session.user.email,
        name: 'Admin E2E',
        tenantId: session.user.tenantId,
        tenantSlug: TENANT_SLUG,
        roles: session.user.roles,
        mfaEnabled: true,
        onboardingCompletedAt: new Date().toISOString(),
      },
    });

    await page.goto('/admin/comunidad/publicaciones-api');
    await expect(page.getByRole('heading', { name: 'Publicaciones por API' })).toBeVisible({
      timeout: 15_000,
    });
    const group = page.getByTestId('api-posts-author-group').first();
    await expect(group).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: title })).toBeVisible();

    // La documentación del endpoint vive en Integraciones → API.
    await page.goto('/admin/integraciones/api');
    await expect(page.getByTestId('community-api-docs')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId('community-api-docs').getByText('POST /api/v1/community-api/posts'),
    ).toBeVisible();
  });
});
