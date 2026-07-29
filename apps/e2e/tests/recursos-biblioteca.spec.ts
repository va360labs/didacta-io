import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Bloque 4 — Biblioteca de recursos (mod.resources):
 *  - El staff publica un recurso desde la UI (modal de /recursos, tipo enlace).
 *  - Un alumno lo ve, busca y filtra por categoría.
 *  - "Abrir" registra la descarga (contador +1, verificado por API).
 *  - Un alumno NO puede publicar (403 por API).
 *
 * Usa sesión REAL (patrón de calendario-agenda.spec.ts).
 */

test.describe('Biblioteca de recursos (mod.resources)', () => {
  test('staff publica, alumno busca/filtra y la descarga cuenta', async ({ page }) => {
    test.setTimeout(120_000);
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    // 1. Un recurso FILE de fondo por API (workflow), para tener dos categorías.
    const fileRes = await fetch(`${API_URL}/api/v1/modules/resources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        category: 'WORKFLOW',
        kind: 'FILE',
        title: `Workflow captación E2E ${stamp}`,
        description: 'El flujo montado en la clase',
        url: 'https://example.com/flujo.json',
        fileName: 'flujo.json',
      }),
    });
    expect(fileRes.status, `crear recurso FILE (${fileRes.status})`).toBe(201);

    // 2. Staff publica un enlace desde la UI (modal de /recursos).
    await page.goto('/signin');
    const adminSession = { accessToken: adminToken };
    await page.evaluate((data) => {
      sessionStorage.setItem('didacta.access_token', data.accessToken);
    }, adminSession);
    // Sesión completa del admin vía helper (roles reales para ver el botón).
    const adminMe = await fetch(`${API_URL}/api/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantSlug,
        email: process.env.E2E_ADMIN_EMAIL,
        password: process.env.E2E_ADMIN_PASSWORD,
      }),
    });
    const adminAuth = (await adminMe.json()) as {
      tokens: { accessToken: string; refreshToken: string };
      user: Record<string, unknown>;
    };
    await injectSession(page, {
      accessToken: adminAuth.tokens.accessToken,
      refreshToken: adminAuth.tokens.refreshToken,
      user: {
        ...(adminAuth.user as never),
        onboardingCompletedAt: new Date().toISOString(),
      },
    });
    await page.goto('/recursos');
    await page.getByRole('button', { name: 'Añadir recurso' }).click();
    const modal = page.getByRole('dialog', { name: 'Nuevo recurso' });
    await modal.getByLabel('Título').fill(`Perplexity E2E ${stamp}`);
    await modal.getByRole('button', { name: 'Herramientas IA' }).click();
    await modal.getByRole('button', { name: 'Enlace' }).click();
    await modal.getByLabel('Enlace').fill('https://perplexity.ai');
    await modal.getByLabel('Descripción (opcional)').fill('Buscador con fuentes citadas');
    await modal.getByRole('button', { name: 'Publicar recurso' }).click();
    await expect(page.getByText(`Perplexity E2E ${stamp}`)).toBeVisible();

    // 3. Alumno: ve, busca y filtra.
    const alumno = await signup({
      tenantSlug,
      email: `e2e-recursos-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Recursos',
    });
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      refreshToken: alumno.tokens.refreshToken,
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });
    await page.goto('/recursos');
    await expect(page.getByText(`Perplexity E2E ${stamp}`)).toBeVisible();
    await expect(page.getByText(`Workflow captación E2E ${stamp}`)).toBeVisible();
    // El alumno no ve el botón de publicar.
    await expect(page.getByRole('button', { name: 'Añadir recurso' })).toHaveCount(0);

    // Buscador (server-side, con debounce).
    await page.getByPlaceholder('Buscar recursos…').fill('perplexity');
    await expect(page.getByText(`Workflow captación E2E ${stamp}`)).toHaveCount(0);
    await expect(page.getByText(`Perplexity E2E ${stamp}`)).toBeVisible();
    await page.getByPlaceholder('Buscar recursos…').clear();

    // Filtro por categoría.
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await expect(page.getByText(`Perplexity E2E ${stamp}`)).toHaveCount(0);
    await expect(page.getByText(`Workflow captación E2E ${stamp}`)).toBeVisible();

    // 4. "Descargar" registra la descarga y abre pestaña nueva.
    const popupPromise = page.waitForEvent('popup');
    await page
      .getByTestId('resource-card')
      .filter({ hasText: `Workflow captación E2E ${stamp}` })
      .getByRole('button', { name: 'Descargar' })
      .click();
    await popupPromise;

    const listRes = await fetch(`${API_URL}/api/v1/modules/resources?q=${stamp}`, {
      headers: { Authorization: `Bearer ${alumno.tokens.accessToken}` },
    });
    const list = (await listRes.json()) as {
      resources: Array<{ title: string; downloadCount: number }>;
    };
    const workflow = list.resources.find((r) => r.title.startsWith('Workflow'));
    expect(workflow?.downloadCount).toBe(1);

    // 5. El alumno no puede publicar (403).
    const forbidden = await fetch(`${API_URL}/api/v1/modules/resources`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alumno.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        category: 'TOOL',
        kind: 'LINK',
        title: 'No debería poder',
        url: 'https://example.com',
      }),
    });
    expect(forbidden.status).toBe(403);
  });
});
