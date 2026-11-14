/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Page } from '@playwright/test';
import { adminSessionForBootstrap, API_URL } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * El detalle de una acción formativa Fundae enseñaba la modalidad con su valor
 * interno («TELEFORMACION») en la etiqueta de la cabecera, en la línea de cada
 * bloque y en el desplegable de modalidad de un bloque nuevo. Ahora se lee la
 * etiqueta del catálogo («Teleformación»; «Online training» en inglés). El
 * valor que se guarda y se exporta no cambia (el XML sigue diciendo
 * TELEFORMACION: lo exige el formato de Fundae).
 */

const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';

async function abrirComoAdmin(page: Page, locale: 'es-ES' | 'en-US', ruta: string) {
  const { accessToken, user } = await adminSessionForBootstrap(tenantSlug);
  const base = process.env.E2E_BASE_URL ?? 'http://localhost:3010';
  await page.context().addCookies([{ name: 'didacta_locale', value: locale, url: base }]);
  await page.goto('/signin');
  await injectSession(page, {
    accessToken,
    user: { ...user, onboardingCompletedAt: new Date().toISOString() } as never,
  });
  await page.goto(ruta);
}

test('Fundae: la modalidad se lee con su etiqueta, nunca con el valor interno', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { accessToken } = await adminSessionForBootstrap(tenantSlug);
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const stamp = Date.now();
  const res = await fetch(`${API_URL}/api/v1/modules/fundae/actions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      codigoAccion: `AF-MOD-${stamp}`,
      nombre: `Acción modalidad ${stamp}`,
      modalidad: 'TELEFORMACION',
      horasFormacion: 10,
      fechaInicio: '2026-05-01',
      fechaFin: '2026-05-15',
      lugar: 'On-line',
    }),
  });
  expect(res.ok, `crear acción (${res.status})`).toBe(true);
  const action = (await res.json()) as { id: string };

  // El valor interno no cambia: es el que exige el XML de Fundae.
  const xml = await (
    await fetch(`${API_URL}/api/v1/modules/fundae/actions/${action.id}/export.xml`, { headers })
  ).text();
  expect(xml).toContain('<modalidad>TELEFORMACION</modalidad>');

  // En español: «Teleformación».
  await abrirComoAdmin(page, 'es-ES', `/admin/fundae/${action.id}`);
  await expect(page.getByRole('heading', { name: `Acción modalidad ${stamp}` })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Teleformación').first()).toBeVisible();
  const opciones = await page.locator('#block-modalidad option').allTextContents();
  expect(opciones).toEqual(['Presencial', 'Teleformación', 'Mixta']);
  expect(await page.locator('body').innerText()).not.toContain('TELEFORMACION');

  // Control en inglés: la etiqueta del catálogo inglés, tampoco el valor interno.
  await abrirComoAdmin(page, 'en-US', `/admin/fundae/${action.id}`);
  await expect(page.getByRole('heading', { name: `Acción modalidad ${stamp}` })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Online training').first()).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('TELEFORMACION');
});
