/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  adminSessionForBootstrap,
  API_URL,
  completeOnboarding,
  E2E_USER_PASSWORD,
  signup,
  TENANT_SLUG,
} from '../helpers/api';
import { injectSession } from '../helpers/auth';

type AuthUser = Awaited<ReturnType<typeof adminSessionForBootstrap>>['user'];

/**
 * Puerta de suscripción del aula (prueba gratis de Didacta Cloud).
 *
 * Recorre el ciclo entero contra el producto de verdad —API, base de datos y
 * navegador—, moviendo la puerta con el mismo `PUT` que usa el plano de control:
 *
 *   TRIAL   el administrador ve la franja con los días y «Elegir plan»; el
 *           alumno no ve nada y sigue estudiando.
 *   LOCKED  pantalla de pausa para todos: el administrador con «Elegir plan»,
 *           el alumno con el mensaje neutro. La API contesta 402 al contenido
 *           y deja vivos el login, `/me` y la marca.
 *   TRIAL vencida  se comporta como LOCKED aunque nadie haya llamado.
 *   OPEN    todo vuelve a como estaba.
 *
 * Toca el tenant principal del arnés: el `afterAll` lo deja SIEMPRE en OPEN.
 */

const ACTION_URL = 'https://didacta.io/es/pricing?upgrade=e2e-token-de-prueba';
const DIA_MS = 86_400_000;

interface GateResponse {
  tenantId: string;
  state: string;
  trialEndsAt: string | null;
  actionUrl: string | null;
  updatedAt: string | null;
}

let admin: { accessToken: string; user: AuthUser };
let alumno: { accessToken: string; user: AuthUser };

async function putGate(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${API_URL}/api/v1/admin/tenants/${admin.user.tenantId}/subscription-gate`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${admin.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function setGate(body: Record<string, unknown>): Promise<GateResponse> {
  const res = await putGate(body);
  expect(res.status, `PUT subscription-gate ${JSON.stringify(body)}`).toBe(200);
  return (await res.json()) as GateResponse;
}

function get(path: string, token?: string): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** Página con la sesión de alguien ya dentro (sin pasar por el formulario). */
async function pageAs(
  browser: Browser,
  who: { accessToken: string; user: AuthUser },
): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'es-ES' });
  const page = await ctx.newPage();
  await page.goto('/signin');
  await injectSession(page, {
    accessToken: who.accessToken,
    user: {
      id: who.user.id,
      email: who.user.email,
      name: who.user.name ?? null,
      tenantId: who.user.tenantId,
      tenantSlug: TENANT_SLUG,
      roles: who.user.roles,
      mfaEnabled: false,
      onboardingCompletedAt: new Date().toISOString(),
    },
  });
  // El asistente de academia del admin ya lo cierra el global-setup; el pase
  // evita que la primera navegación lo vuelva a consultar.
  await page.evaluate(() => window.sessionStorage.setItem('didacta:academia-lista', '1'));
  return page;
}

/**
 * Navega y espera a que el shell haya leído `/me/modules`, que es de donde sale
 * la franja. `networkidle` no sirve: el aula mantiene abierto el canal de
 * notificaciones en tiempo real.
 */
async function gotoShell(page: Page, path: string): Promise<void> {
  const modules = page.waitForResponse((r) => r.url().includes('/api/v1/me/modules'));
  await page.goto(path);
  await modules;
  await expect(page.locator('header').first()).toBeVisible();
  // Margen para que el efecto que pinta (o no) la franja haya corrido.
  await page.waitForTimeout(750);
}

test.describe('Puerta de suscripción del aula', () => {
  test.beforeAll(async () => {
    admin = await adminSessionForBootstrap(TENANT_SLUG);
    const email = `e2e-puerta-${Date.now()}@example.test`;
    const res = await signup({
      tenantSlug: TENANT_SLUG,
      email,
      password: E2E_USER_PASSWORD,
      name: 'Alumna Puerta',
    });
    await completeOnboarding(res.tokens.accessToken);
    alumno = { accessToken: res.tokens.accessToken, user: res.user };
  });

  test.afterAll(async () => {
    // Pase lo que pase arriba, el aula del arnés se queda abierta.
    if (admin) await putGate({ state: 'OPEN' });
  });

  test('el PUT valida el contrato: 400 sin fecha en TRIAL, 400 con http, 404 tenant inexistente', async () => {
    expect((await putGate({ state: 'TRIAL', actionUrl: ACTION_URL })).status).toBe(400);
    expect(
      (
        await putGate({
          state: 'LOCKED',
          actionUrl: 'http://didacta.io/es/pricing?upgrade=x',
        })
      ).status,
    ).toBe(400);
    const missing = await fetch(
      `${API_URL}/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000/subscription-gate`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${admin.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: 'OPEN' }),
      },
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code?: string }).code).toBe('ADMIN_TENANT_NOT_FOUND');
  });

  test('TRIAL: el administrador ve la franja; el alumno no, y sigue estudiando', async ({
    browser,
  }) => {
    const ends = new Date(Date.now() + 4 * DIA_MS + 2 * 3_600_000).toISOString();
    const gate = await setGate({ state: 'TRIAL', trialEndsAt: ends, actionUrl: ACTION_URL });
    expect(gate).toMatchObject({
      tenantId: admin.user.tenantId,
      state: 'TRIAL',
      trialEndsAt: ends,
      actionUrl: ACTION_URL,
    });
    expect(gate.updatedAt).toBeTruthy();

    // Idempotente: lo mismo otra vez no mueve `updatedAt`.
    const again = await setGate({ state: 'TRIAL', trialEndsAt: ends, actionUrl: ACTION_URL });
    expect(again.updatedAt).toBe(gate.updatedAt);

    // La API sigue sirviendo contenido en prueba.
    expect((await get('/api/v1/modules/courses', alumno.accessToken)).status).toBe(200);

    const adminPage = await pageAs(browser, admin);
    await adminPage.goto('/home');
    const banner = adminPage.getByTestId('subscription-trial-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Prueba gratis');
    await expect(banner).toContainText('te quedan 5 días');
    const cta = banner.getByRole('link', { name: /Elegir plan/ });
    await expect(cta).toHaveAttribute('href', ACTION_URL);
    await expect(cta).toHaveAttribute('target', '_blank');
    await expect(adminPage.getByTestId('subscription-lock')).toHaveCount(0);
    await adminPage.context().close();

    const alumnoPage = await pageAs(browser, alumno);
    // El shell está pintado (cabecera con la campana) y aun así no hay franja.
    await gotoShell(alumnoPage, '/home');
    await expect(alumnoPage.getByTestId('subscription-trial-banner')).toHaveCount(0);
    await expect(alumnoPage.getByTestId('subscription-lock')).toHaveCount(0);
    await alumnoPage.context().close();
  });

  test('LOCKED: la API da 402 al contenido y deja vivos login, /me, marca y estado', async () => {
    await setGate({ state: 'LOCKED', actionUrl: ACTION_URL });

    const content = await get('/api/v1/modules/courses', alumno.accessToken);
    expect(content.status).toBe(402);
    expect(((await content.json()) as { code?: string }).code).toBe('SUBSCRIPTION_LOCKED');

    // También el administrador: la pausa no distingue roles en el contenido.
    expect((await get('/api/v1/admin/users', admin.accessToken)).status).toBe(402);

    // Lista blanca.
    const ctx = await get('/api/v1/auth/tenant-context');
    expect(ctx.status).toBe(200);
    const ctxBody = (await ctx.json()) as { tenant: { subscriptionGate?: { state: string } } };
    expect(ctxBody.tenant.subscriptionGate?.state).toBe('LOCKED');

    const signin = await fetch(`${API_URL}/api/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantSlug: TENANT_SLUG,
        email: alumno.user.email,
        password: E2E_USER_PASSWORD,
      }),
    });
    expect(signin.ok, 'el login sigue vivo con el aula en pausa').toBe(true);

    expect((await get('/api/v1/me/profile', alumno.accessToken)).status).toBe(200);
    const mineAdmin = (await (await get('/api/v1/me/modules', admin.accessToken)).json()) as {
      subscriptionGate: { state: string; actionUrl: string | null };
    };
    expect(mineAdmin.subscriptionGate).toMatchObject({ state: 'LOCKED', actionUrl: ACTION_URL });
    const mineAlumno = (await (await get('/api/v1/me/modules', alumno.accessToken)).json()) as {
      subscriptionGate: { state: string; actionUrl: string | null };
    };
    // El alumno sabe que está en pausa, pero el enlace de pago no es suyo.
    expect(mineAlumno.subscriptionGate).toMatchObject({ state: 'LOCKED', actionUrl: null });

    expect((await get('/api/v1/modules/theming/me', admin.accessToken)).status).toBe(200);
  });

  test('LOCKED: el administrador ve «Elegir plan»; el alumno, el mensaje neutro y la puerta al login', async ({
    browser,
  }) => {
    await setGate({ state: 'LOCKED', actionUrl: ACTION_URL });

    const adminPage = await pageAs(browser, admin);
    await adminPage.goto('/home');
    const lockAdmin = adminPage.getByTestId('subscription-lock');
    await expect(lockAdmin).toHaveAttribute('data-variant', 'admin');
    await expect(
      lockAdmin.getByRole('heading', { name: 'Tu prueba gratis ha terminado' }),
    ).toBeVisible();
    await expect(lockAdmin).toContainText('Todo sigue ahí.');
    await expect(lockAdmin).toContainText('Tus cursos y lecciones');
    const choose = adminPage.getByTestId('subscription-lock-choose-plan');
    await expect(choose).toHaveAttribute('href', ACTION_URL);
    await expect(choose).toHaveAttribute('target', '_blank');
    // Nada del aula detrás: ni la barra lateral ni la cabecera del shell.
    await expect(adminPage.locator('aside nav')).toHaveCount(0);
    await adminPage.context().close();

    const alumnoPage = await pageAs(browser, alumno);
    await alumnoPage.goto('/courses');
    const lockAlumno = alumnoPage.getByTestId('subscription-lock');
    await expect(lockAlumno).toHaveAttribute('data-variant', 'other');
    await expect(
      lockAlumno.getByRole('heading', { name: /El acceso a .+ está en pausa/ }),
    ).toBeVisible();
    await expect(lockAlumno).toContainText('Sus responsables ya lo saben.');
    await expect(alumnoPage.getByTestId('subscription-lock-choose-plan')).toHaveCount(0);
    await expect(lockAlumno).not.toContainText('Elegir plan');

    // «¿Eres administrador? Inicia sesión» cierra la sesión del alumno y lleva
    // al login, que sigue accesible con el aula en pausa.
    await alumnoPage.getByTestId('subscription-lock-admin-signin').click();
    await alumnoPage.waitForURL('**/signin');
    await expect(alumnoPage.getByTestId('subscription-lock')).toHaveCount(0);
    await expect(alumnoPage.locator('input[type="email"]')).toBeVisible();
    const token = await alumnoPage.evaluate(() =>
      window.sessionStorage.getItem('didacta.access_token'),
    );
    expect(token).toBeNull();
    await alumnoPage.context().close();

    // Sin sesión, una página pública del aula también enseña la pausa.
    const anon = await browser.newContext({ locale: 'es-ES' });
    const anonPage = await anon.newPage();
    await anonPage.goto('/catalog');
    await expect(anonPage.getByTestId('subscription-lock')).toHaveAttribute(
      'data-variant',
      'other',
    );
    await anon.close();
  });

  test('TRIAL vencida se comporta como LOCKED aunque Cloud no haya llamado', async () => {
    await setGate({
      state: 'TRIAL',
      trialEndsAt: new Date(Date.now() - 60_000).toISOString(),
      actionUrl: ACTION_URL,
    });
    const content = await get('/api/v1/modules/courses', alumno.accessToken);
    expect(content.status).toBe(402);
    const ctx = (await (await get('/api/v1/auth/tenant-context')).json()) as {
      tenant: { subscriptionGate?: { state: string } };
    };
    expect(ctx.tenant.subscriptionGate?.state).toBe('LOCKED');
  });

  test('OPEN borra la prueba y todo vuelve a funcionar', async ({ browser }) => {
    const gate = await setGate({ state: 'OPEN', trialEndsAt: new Date().toISOString() });
    expect(gate).toMatchObject({ state: 'OPEN', trialEndsAt: null, actionUrl: null });
    expect((await get('/api/v1/modules/courses', alumno.accessToken)).status).toBe(200);

    const adminPage = await pageAs(browser, admin);
    await gotoShell(adminPage, '/home');
    await expect(adminPage.getByTestId('subscription-trial-banner')).toHaveCount(0);
    await expect(adminPage.getByTestId('subscription-lock')).toHaveCount(0);
    await adminPage.context().close();
  });
});
