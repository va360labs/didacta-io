/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiAs, freshTenant, type FreshTenant } from '../helpers/simple-tenant';

/**
 * DOMINIOS PROPIOS EN DIDACTA CLOUD: el proxy de Cloud solo enruta los
 * subdominios de la plataforma, así que un dominio propio se «verificaba» y
 * luego daba 404. Con la licencia de edición `cloud`:
 *   - no hay entrada «Dominios propios» en el menú (modo completo) ni en «Más»
 *     (modo sencillo);
 *   - si se llega a `/admin/domains` por enlace, la pantalla lo dice y lleva a
 *     «Dirección de tu academia».
 * La API (no añadir, verificar ni activar) la fija
 * `custom-domains.controller.test.ts`: el arnés no arranca con una licencia
 * de Cloud firmada.
 *
 * La licencia de Cloud se simula respondiendo `GET /api/license` en el
 * navegador con la forma pública real (`edition: 'cloud'`). Cada caso lleva su
 * control en la misma aula: sin simularla, la entrada está.
 */

test.describe.configure({ mode: 'serial' });

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const LICENCIA_CLOUD = {
  status: 'active',
  edition: 'cloud',
  organizationName: 'VA360 Labs',
  expiresAt: '2027-08-12T00:00:00.000Z',
  capabilities: ['feat:multi_tenant.real', 'feat:custom_domains'],
  warnings: [],
};

/** Creadora lista para entrar, con el asistente de la academia cerrado. */
async function creadoraLista(t: FreshTenant): Promise<void> {
  const token = new URL(t.setPasswordUrl).searchParams.get('token')!;
  await apiAs(t.host, '/api/v1/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: t.password },
  });
  const { tokens } = await apiAs<{ tokens: { accessToken: string } }>(
    t.host,
    '/api/v1/auth/signin',
    {
      method: 'POST',
      body: { tenantSlug: t.slug, email: t.creatorEmail, password: t.password },
    },
  );
  const bearer = tokens.accessToken;
  await apiAs(t.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer,
    body: { name: 'Creadora E2E', avatarUrl: '/api/v1/storage/file/avatars/e2e-harness.png' },
  });
  await apiAs(t.host, '/api/v1/me/onboarding/complete', { method: 'POST', bearer });
  await apiAs(t.host, '/api/v1/tenant-settings/onboarding/academy', {
    method: 'PUT',
    bearer,
    body: {
      value: {
        step: 'resumen',
        done: ['nombre', 'marca'],
        skipped: ['curso', 'alumnos', 'cobros', 'correo'],
        completedAt: new Date().toISOString(),
      },
      isSecret: false,
    },
  });
}

/** Entra por la pantalla de acceso; con `cloud`, la licencia es la de Cloud. */
async function entrar(browser: Browser, t: FreshTenant, cloud: boolean): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 } });
  if (cloud) {
    await ctx.route('**/api/license', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(LICENCIA_CLOUD),
      }),
    );
  }
  const page = await ctx.newPage();
  await page.goto(`${t.base}/signin`);
  await page.getByLabel(/Email/).fill(t.creatorEmail);
  await page.getByLabel(/Contraseña/).fill(t.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  return page;
}

/** Espera a que la web haya leído la licencia (la entrada depende de ella). */
async function licenciaLeida(page: Page): Promise<void> {
  await page
    .waitForResponse((r) => r.url().endsWith('/api/license'), { timeout: 20_000 })
    .catch(() => undefined);
}

test('modo completo: sin «Dominios propios» en el menú con la licencia de Cloud; con otra, sí', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const t = await freshTenant(`domcloud${uniq()}`, false);
  await creadoraLista(t);

  // Control: sin la licencia de Cloud, la entrada está.
  const control = await entrar(browser, t, false);
  await control.goto(`${t.base}/admin/branding`);
  await expect(control.getByRole('link', { name: 'Dominios propios' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(control.getByTestId('dominios-cloud')).toHaveCount(0);
  await control.context().close();

  const page = await entrar(browser, t, true);
  const leida = licenciaLeida(page);
  await page.goto(`${t.base}/admin/branding`);
  await leida;
  // El resto del grupo sigue ahí; solo falta la entrada de dominios.
  await expect(page.getByRole('link', { name: 'Branding', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('link', { name: 'Dominios propios' })).toHaveCount(0);

  // Por enlace directo: la pantalla lo explica y lleva a la dirección.
  await page.goto(`${t.base}/admin/domains`);
  const tarjeta = page.getByTestId('dominios-cloud');
  await expect(tarjeta).toBeVisible({ timeout: 20_000 });
  await expect(tarjeta).toContainText('No disponible en Didacta Cloud');
  await expect(page.getByRole('button', { name: /Añadir/ })).toHaveCount(0);
  await tarjeta.getByRole('link', { name: 'Cambiar la dirección de mi academia' }).click();
  await expect(page).toHaveURL(/\/admin\/settings\?tab=general$/);
  await expect(page.getByTestId('direccion-academia')).toBeVisible({ timeout: 20_000 });
  await page.context().close();
});

test('modo sencillo: «Más» no ofrece «Dominios propios» con la licencia de Cloud; con otra, sí', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const t = await freshTenant(`domcloudsen${uniq()}`, true);
  await creadoraLista(t);

  const control = await entrar(browser, t, false);
  await control.goto(`${t.base}/start`);
  await control.getByRole('button', { name: 'Más' }).click();
  await expect(control.getByRole('link', { name: 'Dominios propios', exact: true })).toHaveCount(1);
  await control.context().close();

  const page = await entrar(browser, t, true);
  const leida = licenciaLeida(page);
  await page.goto(`${t.base}/start`);
  await leida;
  await page.getByRole('button', { name: 'Más' }).click();
  // Control dentro del mismo menú: «Más» está abierto y trae lo demás.
  await expect(page.getByRole('link', { name: 'Branding', exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Dominios propios', exact: true })).toHaveCount(0);
  await page.context().close();
});
