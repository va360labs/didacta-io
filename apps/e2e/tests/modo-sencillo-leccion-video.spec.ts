/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { routeTusToDouble, startBunnyDouble, type BunnyDouble } from '../helpers/bunny-double';
import { apiAs, freshTenant, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * MODO SENCILLO: subir el vídeo de una lección, de punta a punta.
 *
 * La creadora elige «Vídeo», arrastra/elige el fichero, ve el progreso, el
 * «preparándose» y el vídeo listo; el vídeo queda GUARDADO en la lección sin
 * pulsar nada más; y una alumna matriculada lo ve en la lección (el
 * reproductor recibe la URL firmada del vídeo subido).
 *
 * Bunny es el doble de `helpers/bunny-double.ts` (la API arranca apuntando a
 * él: `scripts/e2e-env.sh`). Con `E2E_BUNNY_REAL=1` el mismo recorrido va
 * contra la biblioteca de verdad que tenga configurada la API (sin doble), y
 * al final borra el vídeo de Bunny por la propia API.
 *
 * Antes: sin subida configurada el campo no se pintaba y la creadora solo
 * veía «pega el enlace», con el selector prometiendo «Súbelo»; y al pulsar
 * «Vídeo» se creaba una lección vacía aunque cancelase.
 */

const REAL = process.env.E2E_BUNNY_REAL === '1';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'leccion-corta.webm');

let stripe: StripeDouble;
let bunny: BunnyDouble | null = null;

test.beforeAll(async () => {
  stripe = await startStripeDouble();
  if (!REAL) bunny = await startBunnyDouble();
});
test.afterAll(async () => {
  await stripe?.close();
  await bunny?.close();
});

/** Creadora recién llegada: contraseña, entrada y alta en 3 preguntas. */
async function creadoraConCurso(page: Page, tenant: FreshTenant): Promise<void> {
  await page.goto(tenant.setPasswordUrl);
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(tenant.password);
  await pw.nth(1).fill(tenant.password);
  await page
    .getByRole('button', { name: /contraseña|password/i })
    .last()
    .click();
  await page.waitForURL(/\/signin/, { timeout: 20_000 });
  await page.locator('input[autocomplete="email"]').fill(tenant.creatorEmail);
  await page.locator('input[autocomplete="current-password"]').fill(tenant.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/bienvenida/, { timeout: 30_000 });
  await page.getByLabel('Nombre de la academia').fill('Morning Pour');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('¿Cómo se llama el curso?').fill('Espresso at Home');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('Precio').fill('49');
  await page.getByRole('button', { name: 'Crear mi academia' }).click();
  await page.waitForURL(/\/empieza/, { timeout: 30_000 });
}

async function tokenDe(tenant: FreshTenant, email: string): Promise<string> {
  const r = await apiAs<{ tokens: { accessToken: string } }>(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: tenant.slug, email, password: tenant.password },
  });
  return r.tokens.accessToken;
}

interface Lesson {
  id: string;
  title: string;
  type: string;
  content?: { videoUrl?: string };
}

async function leccionesDelCurso(tenant: FreshTenant, bearer: string) {
  const courses = await apiAs<Array<{ id: string; slug: string }>>(
    tenant.host,
    '/api/v1/modules/courses',
    { bearer },
  );
  const course = courses[0]!;
  const detail = await apiAs<{ modules: Array<{ lessons: Lesson[] }> }>(
    tenant.host,
    `/api/v1/modules/courses/${course.id}`,
    { bearer },
  );
  return { course, lessons: detail.modules.flatMap((m) => m.lessons) };
}

test('modo sencillo: subir el vídeo de una lección y que la alumna lo vea', async ({ browser }) => {
  test.setTimeout(REAL ? 600_000 : 180_000);
  const tenant = await freshTenant(`video${Date.now().toString(36)}`, true);
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  if (bunny) await routeTusToDouble(ctx, bunny);
  const page = await ctx.newPage();
  await creadoraConCurso(page, tenant);
  const creadora = await tokenDe(tenant, tenant.creatorEmail);

  // «Añadir mi primera lección» abre el editor con el selector ya abierto.
  await page.getByRole('link', { name: 'Añadir mi primera lección' }).click();
  await expect(page.getByTestId('editor-sencillo')).toBeVisible();
  await expect(page.getByTestId('tipo-VIDEO')).toContainText('Súbelo o pega un enlace');
  await page.getByTestId('tipo-VIDEO').click();

  // Lo primero que se ve es la subida, y elegir «Vídeo» NO crea ninguna lección.
  const soltar = page.getByTestId('video-soltar');
  await expect(soltar).toContainText('Sube tu vídeo');
  await expect(soltar).toContainText('Elegir vídeo');
  await expect(page.getByLabel('O pega el enlace del vídeo (YouTube, Vimeo…)')).toBeVisible();
  expect((await leccionesDelCurso(tenant, creadora)).lessons).toHaveLength(0);

  // Elige el fichero: el título sale del nombre y se ve el progreso.
  await page.getByTestId('video-fichero').setInputFiles({
    name: 'pulling-the-perfect-shot.webm',
    mimeType: 'video/webm',
    buffer: await import('node:fs').then((fs) => fs.readFileSync(FIXTURE)),
  });
  await expect(page.getByLabel('Título de la lección')).toHaveValue('pulling the perfect shot');
  if (!REAL) {
    const subiendo = page.getByTestId('video-subiendo');
    await expect(subiendo).toBeVisible({ timeout: 20_000 });
    await expect(subiendo.getByRole('progressbar')).toBeVisible();
    await expect(subiendo).toContainText('Subiendo:');
    // Mientras sube, «Guardar» espera (cerrar el formulario cortaría la subida).
    await expect(page.getByTestId('guardar-leccion')).toBeDisabled();
  }

  // Subido: «preparándose», y YA guardado en la lección sin pulsar «Guardar».
  const procesando = page.getByTestId('video-procesando');
  await expect(procesando).toBeVisible({ timeout: REAL ? 120_000 : 30_000 });
  await expect(procesando).toContainText('Ya está guardado en la lección');
  const tras = await leccionesDelCurso(tenant, creadora);
  expect(tras.lessons).toHaveLength(1);
  const leccion = tras.lessons[0]!;
  expect(leccion.type).toBe('VIDEO');
  expect(leccion.title).toBe('pulling the perfect shot');
  const embed = leccion.content?.videoUrl ?? '';
  expect(embed).toMatch(/^https:\/\/iframe\.mediadelivery\.net\/embed\/\d+\/[0-9a-f-]{36}$/);
  const guid = embed.split('/').pop()!;
  // Nada técnico a la vista: ni la URL del vídeo subido ni el campo del enlace.
  await expect(page.locator('#leccion-video')).toHaveCount(0);
  expect(await page.getByTestId('editor-sencillo').innerHTML()).not.toContain('mediadelivery');

  if (bunny) {
    // El navegador subió los bytes a «Bunny» con la firma de la API.
    expect(bunny.tus).toEqual({ accepted: 1, rejected: 0 });
    expect(bunny.videos.get(guid)?.received).toBeGreaterThan(30_000);
    bunny.finishEncoding(guid, 3);
  }

  // Listo: el editor lo enseña (sondea cada 5 s; con Bunny real, minutos).
  const listo = page.getByTestId('video-listo');
  await expect(listo).toBeVisible({ timeout: REAL ? 420_000 : 30_000 });
  await expect(listo).toContainText('Listo');
  await expect(listo).toContainText('0:03');
  await page.getByTestId('guardar-leccion').click();
  await expect(page.getByText('1. pulling the perfect shot')).toBeVisible();

  // Publica desde «Empieza aquí», como cualquier creadora.
  await page
    .getByRole('navigation', { name: 'Secciones' })
    .first()
    .getByRole('link', { name: /Empieza aquí/ })
    .click();
  await page.waitForURL(/\/empieza/);
  await page.getByTestId('publicar').click();
  await expect(page.getByTestId('copiar-enlace')).toBeEnabled({ timeout: 20_000 });

  // ── La alumna, matriculada, abre la lección ─────────────────────────────
  const email = `alumna@${tenant.slug}.test`;
  const alta = await apiAs<{ user: { id: string }; tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signup',
    {
      method: 'POST',
      body: { tenantSlug: tenant.slug, email, password: tenant.password, name: 'Alumna E2E' },
    },
  );
  const alumna = alta.tokens.accessToken;
  await apiAs(tenant.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer: alumna,
    body: { avatarUrl: 'https://www.gravatar.com/avatar/0?d=identicon' },
  });
  await apiAs(tenant.host, '/api/v1/me/onboarding/complete', { method: 'POST', bearer: alumna });
  await apiAs(tenant.host, '/api/v1/modules/learning/enrollments', {
    method: 'POST',
    bearer: creadora,
    body: { userId: alta.user.id, courseId: tras.course.id },
  });

  const actx = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1440, height: 900 },
  });
  await actx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  const apage = await actx.newPage();
  if (!REAL) {
    // El reproductor de Bunny no se pide a internet: la biblioteca es del doble.
    await apage.route('https://iframe.mediadelivery.net/**', (r) =>
      r.fulfill({ contentType: 'text/html', body: '<html><body>reproductor</body></html>' }),
    );
  }
  await apage.goto(`${tenant.base}/signin`);
  await apage.locator('input[autocomplete="email"]').fill(email);
  await apage.locator('input[autocomplete="current-password"]').fill(tenant.password);
  await apage.locator('button[type="submit"]').click();
  await apage.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  await apage.goto(`${tenant.base}/cursos/${tras.course.slug}`);
  const iframe = apage.locator(`iframe[src*="/embed/"][src*="${guid}"]`);
  await expect(iframe).toBeAttached({ timeout: 30_000 });
  // Firmada: la biblioteca de Cloud no se sirve sin token.
  expect(await iframe.getAttribute('src')).toMatch(/[?&]token=[0-9a-f]{64}/);

  if (REAL) {
    // Limpieza: fuera de la lección y fuera de Bunny (por la API, como el editor).
    await apiAs(tenant.host, `/api/v1/modules/courses/lessons/${leccion.id}`, {
      method: 'PUT',
      bearer: creadora,
      body: { content: { videoUrl: '' } },
    });
    const assets = await apiAs<Array<{ id: string }>>(
      tenant.host,
      `/api/v1/video/uploads?lessonId=${leccion.id}`,
      { bearer: creadora },
    );
    for (const a of assets) {
      await apiAs(tenant.host, `/api/v1/video/uploads/${a.id}`, {
        method: 'DELETE',
        bearer: creadora,
      });
    }
  }
  await actx.close();
  await ctx.close();
});

test('modo sencillo: aula sin subida de vídeo — lo dice y la lección se hace con un enlace', async ({
  browser,
}) => {
  test.skip(REAL, 'Solo con el doble');
  test.setTimeout(120_000);
  const tenant = await freshTenant(`sinvideo${Date.now().toString(36)}`, true);
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  if (bunny) await routeTusToDouble(ctx, bunny);
  const page = await ctx.newPage();
  // Una instalación sin `BUNNY_STREAM_API_KEY` no registra las rutas de subida:
  // la API contesta 404. Aquí se reproduce esa respuesta en el navegador.
  await page.route('**/api/v1/video/uploads/quota', (r) =>
    r.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' }),
  );
  await creadoraConCurso(page, tenant);
  const creadora = await tokenDe(tenant, tenant.creatorEmail);

  await page.getByRole('link', { name: 'Añadir mi primera lección' }).click();
  await expect(page.getByTestId('tipo-VIDEO')).toContainText('Pega un enlace de YouTube o Vimeo');
  await page.getByTestId('tipo-VIDEO').click();
  await expect(page.getByTestId('video-sin-subida')).toContainText(
    'En esta academia no se pueden subir vídeos',
  );
  await expect(page.getByTestId('video-fichero')).toHaveCount(0);
  await page.getByLabel('Título de la lección').fill('Bienvenida');
  await page
    .getByLabel('Enlace del vídeo (YouTube, Vimeo…)')
    .fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.getByTestId('guardar-leccion').click();
  await expect(page.getByText('1. Bienvenida')).toBeVisible();
  const { lessons } = await leccionesDelCurso(tenant, creadora);
  expect(lessons.map((l) => [l.type, l.content?.videoUrl])).toEqual([
    ['VIDEO', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ]);
  await ctx.close();
});

test('modo sencillo: cancelar una lección de vídeo a medio subir no deja lección ni vídeo', async ({
  browser,
}) => {
  test.skip(REAL, 'Solo con el doble');
  test.setTimeout(120_000);
  const tenant = await freshTenant(`cancela${Date.now().toString(36)}`, true);
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  if (bunny) await routeTusToDouble(ctx, bunny);
  const page = await ctx.newPage();
  await creadoraConCurso(page, tenant);
  const creadora = await tokenDe(tenant, tenant.creatorEmail);
  await page.getByRole('link', { name: 'Añadir mi primera lección' }).click();
  await page.getByTestId('tipo-VIDEO').click();
  // Lento a propósito para cancelar a mitad.
  const antes = bunny!.videos.size;
  await page.getByTestId('video-fichero').setInputFiles(FIXTURE);
  await expect(page.getByTestId('video-subiendo')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Cancelar' }).last().click();
  await expect(page.getByTestId('form-leccion')).toHaveCount(0);
  await expect.poll(async () => (await leccionesDelCurso(tenant, creadora)).lessons.length).toBe(0);
  // El vídeo reservado en Bunny también se borra.
  await expect.poll(() => bunny!.videos.size).toBe(antes);
  await ctx.close();
});
