import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Bloque 4 — Biblioteca de recursos por colecciones (mod.resources):
 *  - El primer listado siembra las 6 colecciones por defecto con badge
 *    "Pronto" (vacías).
 *  - El staff crea una colección nueva desde la UI.
 *  - Un ALUMNO comparte un recurso (enlace) desde el detalle de una colección
 *    — compartir es de todos, no solo del staff.
 *  - El buscador dentro de la colección filtra; "Abrir" cuenta la descarga.
 *  - Un alumno NO puede crear colecciones (403) ni borrar recursos ajenos
 *    (403); sí borra lo suyo.
 *
 * Usa sesión REAL (patrón de calendario-agenda.spec.ts).
 */

async function fullSession(
  page: Parameters<typeof injectSession>[0],
  auth: {
    tokens: { accessToken: string; refreshToken: string };
    user: Parameters<typeof injectSession>[1]['user'];
  },
) {
  await page.goto('/signin');
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...auth.user, onboardingCompletedAt: new Date().toISOString() },
  });
}

test.describe('Biblioteca de recursos por colecciones (mod.resources)', () => {
  test('colecciones default, alta staff, compartir de alumno y descargas', async ({ page }) => {
    test.setTimeout(120_000);
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    // 1. El listado siembra (idempotente) las colecciones por defecto.
    const colsRes = await fetch(`${API_URL}/api/v1/modules/resources/collections`, { headers });
    expect(colsRes.ok, `listar colecciones (${colsRes.status})`).toBe(true);
    const { collections } = (await colsRes.json()) as {
      collections: Array<{ id: string; title: string; resourceCount: number }>;
    };
    expect(collections.length).toBeGreaterThanOrEqual(6);
    const workflows = collections.find((c) => c.title === 'Workflows de clase');
    expect(workflows, 'existe "Workflows de clase"').toBeTruthy();

    // 2. Staff crea una colección desde la UI.
    const adminAuthRes = await fetch(`${API_URL}/api/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantSlug,
        email: process.env.E2E_ADMIN_EMAIL,
        password: process.env.E2E_ADMIN_PASSWORD,
      }),
    });
    const adminAuth = (await adminAuthRes.json()) as never;
    await fullSession(page, adminAuth);
    await page.goto('/recursos');
    await expect(page.getByTestId('collection-card').first()).toBeVisible();

    await page.getByRole('button', { name: 'Nueva colección' }).click();
    const colModal = page.getByRole('dialog', { name: 'Colección' });
    await colModal.getByLabel('Título').fill(`Guías de precios E2E ${stamp}`);
    await colModal.getByLabel('Descripción').fill('Cómo presupuestar proyectos de IA');
    await colModal.getByRole('button', { name: 'Crear colección' }).click();
    await expect(page.getByText(`Guías de precios E2E ${stamp}`).first()).toBeVisible();

    // 3. ALUMNO comparte un recurso (enlace) desde el detalle de una colección.
    const alumno = await signup({
      tenantSlug,
      email: `e2e-recursos-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Recursos',
    });
    await fullSession(page, alumno as never);
    await page.goto(`/recursos/${workflows!.id}`);
    await expect(page.getByRole('heading', { name: 'Workflows de clase' })).toBeVisible();

    await page.getByRole('button', { name: 'Compartir recurso' }).click();
    const shareModal = page.getByRole('dialog', { name: 'Compartir recurso' });
    await shareModal.getByLabel('Título').fill(`Workflow scraping E2E ${stamp}`);
    await shareModal.getByRole('button', { name: 'Enlace' }).click();
    await shareModal.getByLabel('Enlace', { exact: true }).fill('https://n8n.io/workflows/demo');
    await shareModal.getByLabel('Descripción (opcional)').fill('El flujo de scraping de la clase');
    await shareModal.getByRole('button', { name: 'Compartir recurso' }).click();
    await expect(page.getByText(`Workflow scraping E2E ${stamp}`)).toBeVisible();

    // 4. Buscador dentro de la colección.
    await page.getByPlaceholder('Buscar en esta colección…').fill('scraping');
    await expect(page.getByText(`Workflow scraping E2E ${stamp}`)).toBeVisible();
    await page.getByPlaceholder('Buscar en esta colección…').fill('no-existe-nada');
    await expect(page.getByText(`Workflow scraping E2E ${stamp}`)).toHaveCount(0);
    await page.getByPlaceholder('Buscar en esta colección…').clear();

    // 5. "Abrir" cuenta la descarga (la apertura es síncrona y el conteo va en
    //    segundo plano, así que se espera con poll).
    const popupPromise = page.waitForEvent('popup');
    await page
      .getByTestId('resource-card')
      .filter({ hasText: `Workflow scraping E2E ${stamp}` })
      .getByRole('button', { name: 'Abrir' })
      .click();
    await popupPromise;
    let sharedResourceId = '';
    await expect
      .poll(async () => {
        const detailRes = await fetch(
          `${API_URL}/api/v1/modules/resources/collections/${workflows!.id}?q=${stamp}`,
          { headers: { Authorization: `Bearer ${alumno.tokens.accessToken}` } },
        );
        const detail = (await detailRes.json()) as {
          resources: Array<{ id: string; downloadCount: number }>;
        };
        sharedResourceId = detail.resources[0]?.id ?? '';
        return detail.resources[0]?.downloadCount ?? 0;
      })
      .toBe(1);

    // 6. Permisos: el alumno no crea colecciones ni borra recursos ajenos.
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };
    const colForbidden = await fetch(`${API_URL}/api/v1/modules/resources/collections`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: JSON.stringify({ title: 'No debería poder' }),
    });
    expect(colForbidden.status, 'alumno no crea colecciones').toBe(403);

    const ajeno = await fetch(`${API_URL}/api/v1/modules/resources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        collectionId: workflows!.id,
        kind: 'LINK',
        title: `Recurso del admin E2E ${stamp}`,
        url: 'https://example.com/admin',
      }),
    });
    const ajenoBody = (await ajeno.json()) as { id: string };
    const delForbidden = await fetch(`${API_URL}/api/v1/modules/resources/${ajenoBody.id}`, {
      method: 'DELETE',
      headers: alumnoHeaders,
    });
    expect(delForbidden.status, 'alumno no borra recursos ajenos').toBe(403);

    const delMine = await fetch(`${API_URL}/api/v1/modules/resources/${sharedResourceId}`, {
      method: 'DELETE',
      headers: alumnoHeaders,
    });
    expect(delMine.ok, 'alumno borra lo suyo').toBe(true);

    // 7. Un id malformado devuelve 404 limpio, no un 500 de Prisma.
    const malformed = await fetch(`${API_URL}/api/v1/modules/resources/collections/abc`, {
      headers: alumnoHeaders,
    });
    expect(malformed.status, 'id malformado → 404').toBe(404);
  });
});
