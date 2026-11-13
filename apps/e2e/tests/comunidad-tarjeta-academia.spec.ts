/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { injectSession } from '../helpers/auth';
import { apiAs, freshTenant, type FreshTenant } from '../helpers/simple-tenant';

/**
 * La academia se presenta en su comunidad como un grupo de Skool: portada,
 * descripción y enlaces sociales, editados en los Ajustes del modo sencillo y
 * vistos por un alumno en la tarjeta de /community (1440 y 390).
 *
 * Controles: un enlace http no se guarda; sin descripción propia la tarjeta
 * vuelve al titular de acceso, y sin portada a la banda de color.
 */

interface Auth {
  tokens: { accessToken: string; refreshToken: string };
  user: {
    id: string;
    email: string;
    name: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
  };
}

interface Theme {
  about: string | null;
  socialLinks: Array<{ kind: string; url: string }>;
  coverUrl: string | null;
}

const PASSWORD = 'E2eTestPassword123!';
const HEADLINE = 'Café-quality coffee at home, one cup at a time.';
const ABOUT = 'Home baristas learning espresso, milk and latte art together, one cup at a time.';

let aula: FreshTenant;
let operador: Auth;
let alumna: Auth;

async function signinAs(t: FreshTenant, email: string, password: string): Promise<Auth> {
  return apiAs<Auth>(t.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: t.slug, email, password },
  });
}

async function enIngles(t: FreshTenant, a: Auth, password: string): Promise<Auth> {
  await apiAs(t.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer: a.tokens.accessToken,
    body: { locale: 'en-US' },
  });
  return signinAs(t, a.user.email, password);
}

async function abrir(
  browser: Browser,
  auth: Auth,
  path: string,
  width: number,
  height: number,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width, height } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'en-US', url: aula.base }]);
  const page = await ctx.newPage();
  await page.goto(`${aula.base}/signin`);
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...auth.user, onboardingCompletedAt: new Date().toISOString() },
  });
  await page.goto(`${aula.base}${path}`);
  return { page, close: () => ctx.close() };
}

function tema(): Promise<Theme> {
  return apiAs<Theme>(aula.host, '/api/v1/modules/theming/me', {
    bearer: operador.tokens.accessToken,
  });
}

/** Una imagen apaisada de verdad (la API la recomprime con sharp). */
async function portadaPng(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 400;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 800, 400);
    grad.addColorStop(0, '#7a3b1d');
    grad.addColorStop(1, '#e8b48a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 800, 400);
    return c.toDataURL('image/png').split(',')[1]!;
  });
  return Buffer.from(b64, 'base64');
}

test.describe.configure({ mode: 'serial' });

test.describe('comunidad · tarjeta de la academia con portada, descripción y enlaces', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const stamp = Date.now().toString(36);
    aula = await freshTenant(`tarjeta${stamp}`, true);
    operador = await enIngles(
      aula,
      await signinAs(aula, `operador@${aula.slug}.test`, aula.password),
      aula.password,
    );
    const T = operador.tokens.accessToken;
    await apiAs(aula.host, '/api/v1/admin/simple-mode/quick-start', {
      method: 'POST',
      bearer: T,
      body: {
        academyName: 'Morning Pour E2E',
        offer: 'course',
        title: 'Latte Art from Scratch',
        amountCents: 4900,
        currency: 'eur',
        locale: 'en',
      },
    });
    await apiAs(aula.host, '/api/v1/modules/theming/me', {
      method: 'PUT',
      bearer: T,
      body: { signinHeadline: HEADLINE, brandHue: 14, brandSaturation: 72 },
    });
    const a = await apiAs<Auth>(aula.host, '/api/v1/auth/signup', {
      method: 'POST',
      body: {
        tenantSlug: aula.slug,
        email: `ava-${stamp}@example.com`,
        password: PASSWORD,
        name: 'Ava Rossi',
      },
    });
    await apiAs(aula.host, '/api/v1/me/onboarding/complete', {
      method: 'POST',
      bearer: a.tokens.accessToken,
      body: {},
    }).catch(() => undefined);
    alumna = await enIngles(aula, a, PASSWORD);
  });

  test('admin: portada, descripción y enlaces en los Ajustes sencillos (un http no se guarda)', async ({
    browser,
  }) => {
    const { page, close } = await abrir(browser, operador, '/admin/settings', 1440, 900);
    const seccion = page.getByTestId('ajustes-comunidad');
    await expect(seccion).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('How it looks in the community')).toBeVisible();

    // Portada: se sube al momento, como el logo.
    await page.getByTestId('academy-cover-input').setInputFiles({
      name: 'cover.png',
      mimeType: 'image/png',
      buffer: await portadaPng(page),
    });
    await expect(page.getByTestId('academy-cover-preview')).toBeVisible({ timeout: 30_000 });
    expect((await tema()).coverUrl).toMatch(/\/modules\/theming\/tenants\/[0-9a-f-]+\/cover\?v=/);

    await page.getByTestId('academy-about-input').fill(ABOUT);

    // Enlaces: se pega el enlace y sale su icono.
    await page.getByTestId('academy-link-add').click();
    await page.getByTestId('academy-link-input').nth(0).fill('https://instagram.com/');
    await expect(page.getByTestId('academy-link-kind').nth(0)).toHaveAttribute(
      'data-kind',
      'instagram',
    );
    await page.getByTestId('academy-link-add').click();
    const wa = page.getByTestId('academy-link-input').nth(1);
    await wa.fill('http://wa.me/');
    await wa.blur();
    await expect(page.getByText('It must start with https://')).toBeVisible();

    // Control: con un enlace malo no se guarda NADA (tampoco la descripción).
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Check the highlighted links before saving.')).toBeVisible();
    expect((await tema()).about).toBeNull();

    await wa.fill('https://wa.me/');
    await expect(page.getByTestId('academy-link-kind').nth(1)).toHaveAttribute(
      'data-kind',
      'whatsapp',
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });

    const t = await tema();
    expect(t.about).toBe(ABOUT);
    expect(t.socialLinks).toEqual([
      { kind: 'instagram', url: 'https://instagram.com/' },
      { kind: 'whatsapp', url: 'https://wa.me/' },
    ]);

    // Al volver, el editor trae lo guardado.
    await page.reload();
    await expect(page.getByTestId('academy-about-input')).toHaveValue(ABOUT, { timeout: 30_000 });
    await expect(page.getByTestId('academy-link-input')).toHaveCount(2);
    await close();
  });

  test('alumna a 1440: la tarjeta con su portada, la descripción y los enlaces', async ({
    browser,
  }) => {
    const { page, close } = await abrir(browser, alumna, '/community', 1440, 900);
    const tarjeta = page.getByTestId('community-sidebar').getByTestId('community-academy-card');
    await expect(tarjeta).toBeVisible({ timeout: 30_000 });

    // La portada se sirve de verdad (a través de la web) y sustituye a la banda.
    const portada = tarjeta.getByTestId('academy-cover');
    await expect(portada).toBeVisible();
    await expect
      .poll(() => portada.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(800);

    // La descripción propia manda sobre el titular de acceso.
    await expect(tarjeta.getByTestId('academy-description')).toHaveText(ABOUT);

    const enlaces = tarjeta.getByTestId('academy-links').getByRole('link');
    await expect(enlaces).toHaveCount(2);
    await expect(enlaces.nth(0)).toHaveAttribute('href', 'https://instagram.com/');
    await expect(enlaces.nth(0)).toHaveAccessibleName('Instagram (opens in a new tab)');
    await expect(enlaces.nth(1)).toHaveAttribute('href', 'https://wa.me/');
    await expect(enlaces.nth(1)).toHaveAccessibleName('WhatsApp (opens in a new tab)');
    for (const i of [0, 1]) {
      await expect(enlaces.nth(i)).toHaveAttribute('target', '_blank');
      await expect(enlaces.nth(i)).toHaveAttribute('rel', 'noopener noreferrer');
    }
    // La alumna no tiene botón de ajustes.
    await expect(tarjeta.getByTestId('academy-settings')).toHaveCount(0);
    await close();
  });

  test('alumna a 390: la fila plegada sigue arriba y, desplegada, la tarjeta entra sin ensanchar', async ({
    browser,
  }) => {
    const { page, close } = await abrir(browser, alumna, '/community', 390, 844);
    const fila = page.getByTestId('community-sidebar-mobile');
    await expect(fila).toBeVisible({ timeout: 30_000 });
    const boton = fila.getByRole('button', { name: /members/ });
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    // Plegada: ni portada ni enlaces a la vista, y arriba del feed.
    await expect(page.getByTestId('academy-cover')).toHaveCount(0);
    const filaY = (await fila.boundingBox())!.y;
    expect(filaY).toBeLessThan((await page.getByTestId('escribe-algo').boundingBox())!.y);
    expect((await fila.boundingBox())!.height).toBeLessThan(80);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );

    await boton.click();
    const tarjeta = page.getByTestId('community-academy-card');
    await expect(tarjeta.getByTestId('academy-cover')).toBeVisible();
    await expect(tarjeta.getByTestId('academy-description')).toHaveText(ABOUT);
    await expect(tarjeta.getByTestId('academy-links').getByRole('link')).toHaveCount(2);
    const caja = (await tarjeta.boundingBox())!;
    expect(caja.x).toBeGreaterThanOrEqual(0);
    expect(caja.x + caja.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await close();
  });

  test('en Marca (modo completo) están los mismos datos', async ({ browser }) => {
    const { page, close } = await abrir(browser, operador, '/admin/branding', 1440, 900);
    const card = page.getByTestId('branding-academy-profile');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('academy-cover-preview')).toBeVisible();
    await expect(card.getByTestId('academy-about-input')).toHaveValue(ABOUT);
    await expect(card.getByTestId('academy-link-input')).toHaveCount(2);
    await close();
  });

  test('control: sin descripción ni portada, vuelven el titular y la banda de color', async ({
    browser,
  }) => {
    const admin = await abrir(browser, operador, '/admin/settings', 1440, 900);
    await expect(admin.page.getByTestId('academy-cover-preview')).toBeVisible({ timeout: 30_000 });
    await admin.page.getByTestId('academy-cover-remove').click();
    await expect(admin.page.getByTestId('academy-cover-preview')).toHaveCount(0);
    await admin.page.getByTestId('academy-about-input').fill('');
    await admin.page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(admin.page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
    await admin.close();
    const t = await tema();
    expect(t.about).toBeNull();
    expect(t.coverUrl).toBeNull();

    const { page, close } = await abrir(browser, alumna, '/community', 1440, 900);
    const tarjeta = page.getByTestId('community-sidebar').getByTestId('community-academy-card');
    await expect(tarjeta.getByTestId('academy-description')).toHaveText(HEADLINE, {
      timeout: 30_000,
    });
    await expect(tarjeta.getByTestId('academy-cover')).toHaveCount(0);
    // Los enlaces siguen (no se tocaron).
    await expect(tarjeta.getByTestId('academy-links').getByRole('link')).toHaveCount(2);
    await close();
  });
});
