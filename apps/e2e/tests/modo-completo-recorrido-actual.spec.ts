/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { freshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * LÍNEA BASE del recorrido de hoy (MODO COMPLETO), medida igual que
 * `modo-sencillo-de-cero.spec.ts`: una creadora recién llegada, desde que
 * entra hasta tener el enlace de venta de un curso con precio, y un visitante
 * que abre ese enlace y ve el botón de compra. Recorre la interfaz real (sin
 * atajos por API): perfil con foto obligatoria, asistente de academia de 8
 * pasos (lo mínimo; lo saltable, saltado), crear curso, sección y lección de
 * texto, publicar, poner precio y llegar al enlace público.
 *
 * Sin umbral: es la referencia con la que se compara el modo sencillo.
 */

interface Tramo {
  clicks: number;
  fields: number;
}

const tramos: Record<string, Tramo> = {};
let actual = 'acceso';

function tramo(nombre: string) {
  actual = nombre;
  tramos[nombre] = tramos[nombre] ?? { clicks: 0, fields: 0 };
}
async function click(l: Locator) {
  tramos[actual]!.clicks += 1;
  await l.click();
}
async function fill(l: Locator, v: string) {
  tramos[actual]!.fields += 1;
  await l.fill(v);
}

/** PNG de 8×8 (válido) para la foto de perfil obligatoria. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8DwnwELYBhcSQB+ow/xqh2aZQAAAABJRU5ErkJggg==',
  'base64',
);

let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

async function botonVisible(page: Page, name: RegExp): Promise<Locator> {
  const b = page.getByRole('button', { name }).last();
  await expect(b).toBeVisible({ timeout: 20_000 });
  return b;
}

test('modo completo (hoy): de cero a enlace de venta con precio', async ({ browser }) => {
  test.setTimeout(300_000);
  const tenant = await freshTenant(`completo${Date.now().toString(36)}`, false);
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  const page = await ctx.newPage();

  // ── Acceso (igual en los dos modos; se cuenta aparte) ───────────────────
  tramo('acceso');
  await page.goto(tenant.setPasswordUrl);
  const pw = page.locator('input[type="password"]');
  await fill(pw.nth(0), tenant.password);
  await fill(pw.nth(1), tenant.password);
  await click(page.getByRole('button', { name: /contraseña|password/i }).last());
  await page.waitForURL(/\/signin/, { timeout: 20_000 });
  await fill(page.locator('input[autocomplete="email"]'), tenant.creatorEmail);
  await fill(page.locator('input[autocomplete="current-password"]'), tenant.password);
  await click(page.locator('button[type="submit"]'));

  // ── Perfil: foto OBLIGATORIA, nombre, avisos, listo ─────────────────────
  tramo('perfil');
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  const elegir = page.waitForEvent('filechooser');
  await click(page.getByRole('button', { name: /Subir foto/ }));
  await (await elegir).setFiles({ name: 'foto.png', mimeType: 'image/png', buffer: PNG });
  tramos.perfil!.fields += 1; // elegir la foto
  const continuar = page.getByRole('button', { name: 'Continuar' });
  await expect(continuar).toBeEnabled({ timeout: 20_000 });
  await click(continuar);
  await fill(page.locator('#ob-name'), 'Marta Ríos');
  await click(continuar);
  await click(continuar);
  await click(page.getByRole('button', { name: /Entrar a la plataforma/ }));

  // ── Asistente de academia (8 pasos) ─────────────────────────────────────
  tramo('asistente');
  await page.waitForURL(/\/welcome/, { timeout: 30_000 });
  await click(await botonVisible(page, /^Empezar$/));
  await fill(page.locator('#nombre-academia'), 'Taller de Acuarela');
  await click(await botonVisible(page, /^Continuar$/)); // nombre
  await click(await botonVisible(page, /^Continuar$/)); // marca (color por defecto, sin logo)
  await click(await botonVisible(page, /^Ahora no$/)); // curso
  await click(await botonVisible(page, /^Ahora no$/)); // alumnos
  await click(await botonVisible(page, /^(Ahora no|Continuar)$/)); // cobros
  await click(await botonVisible(page, /^(Ahora no|Continuar)$/)); // correo
  await click(await botonVisible(page, /Entrar en mi academia/));
  await page.waitForURL((u) => !u.pathname.startsWith('/welcome'), { timeout: 30_000 });

  // ── Curso: Mis cursos → Nuevo curso → título → Crear ────────────────────
  tramo('curso');
  await click(page.getByRole('link', { name: 'Mis cursos' }).first());
  await page.waitForURL(/\/studio\/courses$/);
  await click(page.getByText('Crear curso nuevo').first());
  await fill(page.locator('#title'), 'Acuarela desde cero');
  await click(page.locator('form button[type="submit"]').last());
  await page.waitForURL(/\/studio\/courses\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const slug = 'acuarela-desde-cero';

  // ── Sección y lección de texto ──────────────────────────────────────────
  tramo('leccion');
  await click(page.getByRole('button', { name: 'Añadir sección' }));
  await fill(page.getByPlaceholder('Título de la sección'), 'Lecciones');
  await click(page.getByRole('button', { name: 'Crear sección' }));
  await click(await botonVisible(page, /^Añadir lección$/));
  await fill(page.getByPlaceholder('Título de la lección'), 'Bienvenida');
  await click(page.getByRole('button', { name: /^Crear$/ }));
  await click(
    page
      .locator('li')
      .filter({ hasText: 'Bienvenida' })
      .getByRole('button', { name: /^Editar$/ })
      .first(),
  );
  await fill(
    page.getByLabel(/^Texto$/),
    'Hola. En este curso aprenderás a pintar con acuarela desde cero.',
  );
  await click(await botonVisible(page, /Guardar cambios/));
  await expect(page.getByLabel(/^Texto$/)).toHaveCount(0, { timeout: 20_000 });

  // ── Publicar ────────────────────────────────────────────────────────────
  tramo('publicar');
  await click(await botonVisible(page, /^Publicar$/));
  await expect(page.locator('#course-price-amount')).toBeVisible({ timeout: 20_000 });

  // ── Precio ──────────────────────────────────────────────────────────────
  tramo('precio');
  await fill(page.locator('#course-price-amount'), '49');
  await click(await botonVisible(page, /Poner a la venta/));
  await expect
    .poll(
      () => stripe.calls.some((x) => x.path === '/v1/prices' && x.body.unit_amount === '4900'),
      { timeout: 20_000 },
    )
    .toBe(true);

  // ── Enlace de venta: la interfaz NO lo ofrece en ningún sitio ───────────
  // Ni botón de copiar ni enlace a la ficha pública: la creadora tiene que
  // saber que existe /catalog/<slug> y escribirlo en la barra. Se cuenta
  // como 1 campo (escribir la dirección).
  tramo('enlace');
  tramos.enlace!.fields += 1;
  const enlace = `${tenant.base}/catalog/${slug}`;

  // ── Visitante ───────────────────────────────────────────────────────────
  const visitante = await browser.newContext({ locale: 'es-ES' });
  const v = await visitante.newPage();
  await v.goto(enlace);
  await expect(v.getByRole('heading', { name: /Acuarela desde cero/ }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(v.getByRole('button', { name: /comprar/i }).first()).toBeVisible();

  const hasta = Object.entries(tramos).filter(([k]) => k !== 'acceso');
  const resultado = {
    acceso: { clicks: tramos.acceso!.clicks, campos: tramos.acceso!.fields },
    hastaEnlace: {
      clicks: hasta.reduce((s, [, t]) => s + t.clicks, 0),
      campos: hasta.reduce((s, [, t]) => s + t.fields, 0),
    },
    tramos: Object.fromEntries(hasta.map(([k, t]) => [k, { clicks: t.clicks, campos: t.fields }])),
  };
  // eslint-disable-next-line no-console
  console.log('[modo completo] recuento', JSON.stringify(resultado));
  if (process.env.E2E_RECUENTO_FILE)
    writeFileSync(process.env.E2E_RECUENTO_FILE, JSON.stringify(resultado, null, 2));
  await visitante.close();
  await ctx.close();
});
