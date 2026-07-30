import { expect, test, type Page } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';

/**
 * Rediseño de /signin: pantalla partida con panel de marca a la izquierda.
 *
 * Lo que se verifica aquí, además del layout:
 *  - El copy del panel es el que el admin guarda en /admin/branding (mod.theming),
 *    NO texto hardcodeado en el web. Se escribe por API y se comprueba en pantalla.
 *  - Las cifras del panel son reales: coinciden con lo que devuelve
 *    `GET /auth/tenant-context`, no con constantes del front.
 *  - El título del navegador lleva el tenant: "… | <Tenant> powered by Didacta".
 *  - "Mantener la sesión abierta" decide de verdad dónde vive la sesión
 *    (localStorage marcado / sessionStorage desmarcado).
 *  - El formulario sigue funcionando: login real y redirección.
 */

const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'va360';

const HEADLINE = 'Formación E2E aplicada, con la comunidad que la usa cada día.';
const SUBHEADLINE = 'Copy de prueba del panel de acceso.';

interface TenantContext {
  tenant: {
    name: string;
    headline: string | null;
    subheadline: string | null;
    stats: { activeMembers: number; publishedCourses: number };
  } | null;
}

async function themingHeaders(): Promise<Record<string, string>> {
  const bearer = await adminTokenForBootstrap(TENANT_SLUG);
  return { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' };
}

async function setSigninCopy(
  headers: Record<string, string>,
  copy: { signinHeadline: string | null; signinSubheadline: string | null },
): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/modules/theming/me`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(copy),
  });
  expect(res.ok, 'PUT /modules/theming/me con el copy del login').toBe(true);
}

async function fetchTenantContext(): Promise<TenantContext> {
  const res = await fetch(`${API_URL}/api/v1/auth/tenant-context`);
  expect(res.ok, 'GET /auth/tenant-context').toBe(true);
  return (await res.json()) as TenantContext;
}

/** Alumno con onboarding cerrado: puede entrar por el formulario real. */
async function createAlumno(stamp: number) {
  const email = `e2e-signin-${stamp}@example.test`;
  const password = 'E2eSignin123!';
  const alumno = await signup({ tenantSlug: TENANT_SLUG, email, password, name: 'Alumna Acceso' });
  const bearer = alumno.tokens.accessToken;
  const patch = await fetch(`${API_URL}/api/v1/me/profile`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatarUrl: 'https://example.test/avatar-e2e.png' }),
  });
  expect(patch.ok, 'avatar para completar onboarding').toBe(true);
  const complete = await fetch(`${API_URL}/api/v1/me/onboarding/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
  });
  expect(complete.ok, 'completar onboarding por API').toBe(true);
  return { email, password };
}

async function storageSnapshot(page: Page) {
  return page.evaluate(() => ({
    local: {
      access: localStorage.getItem('didacta.access_token'),
      refresh: localStorage.getItem('didacta.refresh_token'),
      session: localStorage.getItem('didacta.session'),
    },
    session: {
      access: sessionStorage.getItem('didacta.access_token'),
      refresh: sessionStorage.getItem('didacta.refresh_token'),
      session: sessionStorage.getItem('didacta.session'),
    },
  }));
}

test.describe('/signin — rediseño con panel de marca', () => {
  test('el panel pinta el copy del tenant y las cifras REALES de la API', async ({ page }) => {
    const headers = await themingHeaders();
    await setSigninCopy(headers, {
      signinHeadline: HEADLINE,
      signinSubheadline: SUBHEADLINE,
    });

    try {
      const ctx = await fetchTenantContext();
      expect(ctx.tenant, 'el host de E2E resuelve un tenant').not.toBeNull();
      const tenant = ctx.tenant!;
      expect(tenant.headline).toBe(HEADLINE);

      await page.goto('/signin');

      // Copy del tenant, no del código del web.
      await expect(page.getByRole('heading', { name: HEADLINE })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(SUBHEADLINE)).toBeVisible();

      // Cifras: exactamente las que devuelve la API para este tenant.
      if (tenant.stats.activeMembers > 0) {
        const label = tenant.stats.activeMembers === 1 ? 'alumno activo' : 'alumnos activos';
        await expect(
          page.getByText(String(tenant.stats.activeMembers), { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(label, { exact: true })).toBeVisible();
      }
      if (tenant.stats.publishedCourses > 0) {
        const label = tenant.stats.publishedCourses === 1 ? 'curso incluido' : 'cursos incluidos';
        await expect(page.getByText(label, { exact: true })).toBeVisible();
      }

      // Pie del panel con el nombre real del tenant.
      await expect(page.getByText(`${tenant.name} · Acceso privado a la plataforma`)).toBeVisible();

      // El formulario sigue en su sitio.
      await expect(page.getByRole('heading', { name: 'Bienvenido de nuevo' })).toBeVisible();
      await expect(page.getByLabel(/Email/)).toBeVisible();
      await expect(page.getByLabel(/Contraseña/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
    } finally {
      await setSigninCopy(headers, { signinHeadline: null, signinSubheadline: null });
    }
  });

  test('sin copy propio, el panel cae al texto genérico de Didacta', async ({ page }) => {
    const headers = await themingHeaders();
    await setSigninCopy(headers, { signinHeadline: null, signinSubheadline: null });

    await page.goto('/signin');
    await expect(
      page.getByRole('heading', { name: 'Entra en tu espacio de formación.' }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('el título del navegador lleva el tenant: «… | <Tenant> powered by Didacta»', async ({
    page,
  }) => {
    const ctx = await fetchTenantContext();
    const name = ctx.tenant?.name ?? '';
    test.skip(!name || name === 'Didacta', 'requiere un tenant resuelto con nombre propio');

    await page.goto('/signin');
    await expect(page).toHaveTitle(`Iniciar sesión | ${name} powered by Didacta`, {
      timeout: 15_000,
    });
    // "Didacta" nunca solo: el sufijo genérico no debe sobrevivir.
    await expect(page).not.toHaveTitle('Iniciar sesión | Didacta');
  });

  test('«Mantener la sesión abierta» marcado → la sesión vive en localStorage', async ({
    page,
  }) => {
    const alumno = await createAlumno(Date.now());

    await page.goto('/signin');
    const remember = page.getByLabel('Mantener la sesión abierta');
    await expect(remember).toBeChecked(); // marcado por defecto, como en el diseño
    await page.getByLabel(/Email/).fill(alumno.email);
    await page.getByLabel(/Contraseña/).fill(alumno.password);
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page).not.toHaveURL(/\/signin/, { timeout: 15_000 });
    const stored = await storageSnapshot(page);
    expect(stored.local.access, 'access token en localStorage').not.toBeNull();
    expect(stored.local.refresh, 'refresh token en localStorage').not.toBeNull();
    expect(stored.session.access, 'nada en sessionStorage').toBeNull();
  });

  test('desmarcado → la sesión vive en sessionStorage y muere con la pestaña', async ({ page }) => {
    const alumno = await createAlumno(Date.now() + 1);

    await page.goto('/signin');
    await page.getByLabel('Mantener la sesión abierta').uncheck();
    await page.getByLabel(/Email/).fill(alumno.email);
    await page.getByLabel(/Contraseña/).fill(alumno.password);
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page).not.toHaveURL(/\/signin/, { timeout: 15_000 });
    const stored = await storageSnapshot(page);
    expect(stored.session.access, 'access token en sessionStorage').not.toBeNull();
    expect(stored.session.refresh, 'refresh token en sessionStorage').not.toBeNull();
    expect(stored.local.access, 'nada persistente en localStorage').toBeNull();
    expect(stored.local.refresh, 'nada persistente en localStorage').toBeNull();
  });
});
