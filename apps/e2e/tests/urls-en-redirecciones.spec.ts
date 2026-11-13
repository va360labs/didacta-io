/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  adminTokenForBootstrap,
  API_URL,
  createPublishedCourse,
  E2E_USER_PASSWORD,
  signupOnboarded,
  TENANT_SLUG,
} from '../helpers/api';
import { injectSession } from '../helpers/auth';
import { sql } from '../helpers/simple-tenant';

/**
 * Las URL del aula pasaron del español al inglés. Lo que ya está fuera sigue
 * funcionando: cada ruta vieja contesta 308 a la nueva conservando los
 * segmentos dinámicos y la query entera.
 *
 * La tabla de aquí es una copia INDEPENDIENTE de la del producto
 * (`apps/web/src/lib/legacy-routes.ts`): si alguien borra o cambia una entrada
 * allí, este spec lo caza en vez de darle la razón.
 *
 *  1. Cada ruta vieja → 308 con `Location` = la nueva + la misma query.
 *  2. Cada destino que es una página responde (no es un 404).
 *  3. De verdad, en el navegador: el enlace de venta compartido
 *     `/catalogo/<slug>?ref=X` acaba en `/catalog/<slug>?ref=X` con la ficha
 *     del curso, y la vuelta de Stripe conserva su `session_id`.
 *  4. Los valores de pestaña de antes (`?tab=seguridad`, `?tab=negocio`…) y
 *     `?vista=eventos`: la pantalla abre la pestaña que toca y la URL pasa a
 *     la nueva sin entrada nueva en el historial.
 */

const RUTAS: ReadonlyArray<readonly [string, string]> = [
  ['/admin/auditoria', '/admin/audit'],
  ['/admin/avisos', '/admin/broadcasts'],
  ['/admin/cobros', '/admin/payments'],
  ['/admin/competencias', '/admin/competencies'],
  ['/admin/comunidad/espacios', '/admin/community/spaces'],
  ['/admin/comunidad/publicaciones-api', '/admin/community/api-posts'],
  ['/admin/comunidad/tags', '/admin/community/tags'],
  ['/admin/configuracion', '/admin/settings'],
  ['/admin/cursos/categorias', '/admin/courses/categories'],
  ['/admin/cursos/imagenes', '/admin/courses/images'],
  ['/admin/dominios', '/admin/domains'],
  ['/admin/encuestas', '/admin/surveys'],
  ['/admin/fundae/empresas', '/admin/fundae/companies'],
  ['/admin/fundae/grupos', '/admin/fundae/groups'],
  ['/admin/gamificacion', '/admin/gamification'],
  ['/admin/grupos-acceso', '/admin/access-groups'],
  ['/admin/ia/providers', '/admin/ai/providers'],
  ['/admin/ia/tutor', '/admin/ai/tutor'],
  ['/admin/imagenes', '/admin/images'],
  ['/admin/impagos', '/admin/delinquents'],
  ['/admin/integraciones/api', '/admin/integrations/api'],
  ['/admin/integraciones/payment-connections', '/admin/integrations/payment-connections'],
  ['/admin/invitaciones', '/admin/invitations'],
  ['/admin/licencia', '/admin/license'],
  ['/admin/membresia', '/admin/membership'],
  ['/admin/metricas', '/admin/metrics'],
  ['/admin/referidos', '/admin/referrals'],
  ['/admin/seguridad', '/admin/security'],
  ['/admin/solicitudes-miembros', '/admin/member-requests'],
  ['/admin/tenants/nuevo', '/admin/tenants/new'],
  ['/admin/usuarios', '/admin/users'],
  ['/admin/usuarios/importar', '/admin/users/import'],
  ['/admin/usuarios/invitar', '/admin/users/invite'],
  ['/formador', '/studio'],
  ['/formador/cursos', '/studio/courses'],
  ['/formador/cursos/nuevo', '/studio/courses/new'],
  ['/formador/aula-virtual', '/studio/live'],
  ['/formador/certificados/templates', '/studio/certificates/templates'],
  ['/formador/correcciones', '/studio/grading'],
  ['/formador/rutas', '/studio/paths'],
  ['/formador/rutas/nueva', '/studio/paths/new'],
  ['/calendario', '/calendar'],
  ['/comunidad', '/community'],
  ['/comunidad/menciones', '/community/mentions'],
  ['/cuenta', '/account'],
  ['/cuenta/suscripciones', '/account/subscriptions'],
  ['/cursos', '/courses'],
  ['/empieza', '/start'],
  ['/eventos', '/events'],
  ['/grupos', '/groups'],
  ['/inicio', '/home'],
  ['/inicio/mi-panel', '/home/dashboard'],
  ['/mensajes', '/messages'],
  ['/miembros', '/members'],
  ['/mis-certificados', '/my-certificates'],
  ['/notificaciones', '/notifications'],
  ['/recursos', '/resources'],
  ['/referidos', '/referrals'],
  ['/retos', '/challenges'],
  ['/rutas', '/paths'],
  ['/seguimiento', '/inspection'],
  ['/soporte/acceso', '/support/access'],
  ['/inscripcion-miembros', '/member-registration'],
  ['/inscripcion-miembros/decision', '/member-registration/decision'],
  ['/catalogo', '/catalog'],
  ['/condiciones-referidos', '/referral-terms'],
  ['/unete', '/join'],
  ['/bienvenida', '/welcome'],
];

/** Con segmento dinámico: se conserva tal cual (y lo de detrás también). */
const DINAMICAS: ReadonlyArray<readonly [string, string]> = [
  ['/catalogo/acuarela-desde-cero', '/catalog/acuarela-desde-cero'],
  ['/catalogo/checkout/success', '/catalog/checkout/success'],
  ['/cursos/checkout/success', '/courses/checkout/success'],
  ['/cursos/mi-curso', '/courses/mi-curso'],
  ['/clase/7c1e4c52-6f5e-4b0a-9a39-1b2c3d4e5f60', '/live/7c1e4c52-6f5e-4b0a-9a39-1b2c3d4e5f60'],
  [
    '/verificar/7c1e4c52-6f5e-4b0a-9a39-1b2c3d4e5f60',
    '/verify/7c1e4c52-6f5e-4b0a-9a39-1b2c3d4e5f60',
  ],
  ['/comunidad/p-1', '/community/p-1'],
  ['/espacios/general', '/spaces/general'],
  ['/recursos/r-1', '/resources/r-1'],
  ['/rutas/mi-ruta', '/paths/mi-ruta'],
  ['/grupos/g-1', '/groups/g-1'],
  ['/formador/cursos/c-1', '/studio/courses/c-1'],
  ['/formador/cursos/c-1/alumnos', '/studio/courses/c-1/students'],
  ['/formador/cursos/c-1/alumnos/e-1', '/studio/courses/c-1/students/e-1'],
  ['/formador/correcciones/x-1', '/studio/grading/x-1'],
  ['/formador/quizzes/q-1', '/studio/quizzes/q-1'],
  ['/admin/usuarios/u-1', '/admin/users/u-1'],
  ['/admin/fundae/empresas/e-1', '/admin/fundae/companies/e-1'],
];

const QUERY = '?ref=E2EREF&utm_source=correo';

test('cada ruta vieja en español → 308 a la nueva, con la query entera', async ({ request }) => {
  for (const [vieja, nueva] of [...RUTAS, ...DINAMICAS]) {
    const res = await request.get(`${vieja}${QUERY}`, { maxRedirects: 0 });
    expect(res.status(), vieja).toBe(308);
    const destino = new URL(res.headers()['location']!, 'http://x');
    expect(`${destino.pathname}${destino.search}`, vieja).toBe(`${nueva}${QUERY}`);
  }
  // Control: la ruta nueva NO redirige (si no, el 308 de arriba no probaría nada).
  for (const ruta of ['/catalog', '/community', '/studio/courses', '/start']) {
    const res = await request.get(ruta, { maxRedirects: 0 });
    expect(res.status(), ruta).not.toBe(308);
  }
});

test('cada destino de la tabla es una página que existe', async ({ request }) => {
  for (const [, nueva] of RUTAS) {
    const res = await request.get(nueva);
    expect(res.status(), nueva).not.toBe(404);
    expect(res.status(), nueva).toBeLessThan(500);
  }
  // Control: una ruta que no existe sí da 404 (la comprobación discrimina).
  expect((await request.get('/no-existe-esta-ruta')).status()).toBe(404);
});

test('enlace de venta compartido /catalogo/<slug>?ref=X → /catalog/<slug>?ref=X con la ficha', async ({
  page,
}) => {
  const token = await adminTokenForBootstrap(process.env.E2E_TENANT_SLUG ?? 'demo');
  const slug = `urls-en-${Date.now().toString(36)}`;
  const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
  const course = await createPublishedCourse({ bearer: token, title: 'Acuarela para urls', slug });
  // A la venta: una opción de compra activa (crearla por API exige Stripe;
  // se siembra como en catalogo-publico.spec.ts).
  const id = randomUUID();
  sql(
    `INSERT INTO mod_billing_product (id, tenant_id, course_id, stripe_product_id, stripe_price_id, unit_amount, currency, updated_at) ` +
      `SELECT '${id}', t.id, '${course.id}', 'prod_e2e_${id.slice(0, 8)}', 'price_e2e_${id.slice(0, 8)}', 4900, 'eur', now() ` +
      `FROM tenant t WHERE t.slug = '${tenantSlug}'`,
  );

  await page.goto(`/catalogo/${slug}?ref=E2EREF`);
  await expect(page).toHaveURL(new RegExp(`/catalog/${slug}\\?ref=E2EREF$`));
  await expect(page.getByRole('heading', { name: /Acuarela para urls/ }).first()).toBeVisible({
    timeout: 20_000,
  });

  // El catálogo entero, también con su ref.
  await page.goto('/catalogo?ref=E2EREF');
  await expect(page).toHaveURL(/\/catalog\?ref=E2EREF$/);

  // La vuelta de Stripe de un pago empezado antes del cambio.
  await page.goto('/catalogo/checkout/success?session_id=cs_test_urls_en');
  await expect(page).toHaveURL(/\/catalog\/checkout\/success\?session_id=cs_test_urls_en$/);
});

/** Sesión del administrador del tenant de la suite, inyectada en la pestaña. */
async function comoAdmin(page: Page): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantSlug: TENANT_SLUG,
      email: process.env.E2E_ADMIN_EMAIL,
      password: process.env.E2E_ADMIN_PASSWORD,
    }),
  });
  expect(res.ok, `signin admin (${res.status})`).toBe(true);
  const auth = (await res.json()) as {
    tokens: { accessToken: string; refreshToken: string };
    user: Parameters<typeof injectSession>[1]['user'];
  };
  await page.goto('/signin');
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...auth.user, onboardingCompletedAt: new Date().toISOString() },
  });
}

test('valores de pestaña de antes: abren la pestaña y la URL pasa a la nueva sin entrada en el historial', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const miembro = await signupOnboarded({
    tenantSlug: TENANT_SLUG,
    email: `urls-tab-${Date.now().toString(36)}@e2e.test`,
    password: E2E_USER_PASSWORD,
    name: 'Miembro del expediente',
  });
  await comoAdmin(page);

  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  const casos: Array<{ vieja: string; nueva: string; abierta: () => Locator }> = [
    // El cambio de contraseña obligatorio manda aquí.
    { vieja: '/account?tab=seguridad', nueva: '/account?tab=security', abierta: () => tab('Seguridad') },
    // La vuelta del portal de facturación de Stripe de una sesión de antes.
    {
      vieja: '/account?tab=suscripcion&status=success',
      nueva: '/account?tab=subscription&status=success',
      abierta: () => tab('Suscripción'),
    },
    { vieja: '/account?tab=notificaciones', nueva: '/account?tab=notifications', abierta: () => tab('Notificaciones') },
    // Ruta de antes Y valor de antes: 308 y luego la pestaña.
    { vieja: '/cuenta?tab=seguridad', nueva: '/account?tab=security', abierta: () => tab('Seguridad') },
    { vieja: '/admin?tab=negocio', nueva: '/admin?tab=business', abierta: () => tab('Negocio') },
    { vieja: '/admin/settings?tab=registro', nueva: '/admin/settings?tab=registration', abierta: () => tab('Registro') },
    { vieja: '/admin/settings?tab=pagos', nueva: '/admin/settings?tab=payments', abierta: () => tab('Pagos') },
    // La pestaña que aporta el módulo de directos (declara su valor de antes).
    {
      vieja: '/admin/configuracion?tab=aula-virtual',
      nueva: '/admin/settings?tab=virtual-classroom',
      abierta: () => tab('Aula virtual'),
    },
    { vieja: '/admin/api-keys?tab=claves', nueva: '/admin/api-keys?tab=keys', abierta: () => tab('Claves') },
    { vieja: '/admin/webhooks?tab=salientes', nueva: '/admin/webhooks?tab=outbound', abierta: () => tab('Salientes') },
    {
      vieja: `/u/${miembro.user.id}?tab=acceso`,
      nueva: `/u/${miembro.user.id}?tab=access`,
      abierta: () => page.getByTestId('dossier-tab-access'),
    },
    { vieja: '/calendario?vista=eventos', nueva: '/calendar?view=events', abierta: () => page.getByRole('button', { name: 'Eventos', exact: true }) },
  ]; // prettier-ignore

  for (const { vieja, nueva, abierta } of casos) {
    await page.goto('/community');
    await expect(page).toHaveURL(/\/community$/);
    await page.goto(vieja);
    await expect(page, vieja).toHaveURL(nueva, { timeout: 20_000 });
    const el = abierta();
    await expect(el, vieja).toBeVisible({ timeout: 20_000 });
    if (vieja.startsWith('/u/')) {
      await expect(el, vieja).toHaveClass(/border-brand-500/);
    } else if (vieja.includes('vista=')) {
      await expect(el, vieja).toHaveClass(/text-white/);
    } else {
      await expect(el, vieja).toHaveAttribute('aria-selected', 'true');
    }
    // Replace, no push: «atrás» vuelve a la página de antes, no a la URL vieja.
    await page.goBack();
    await expect(page, `${vieja} dejó una entrada en el historial`).toHaveURL(/\/community$/);
  }

  // Control: un valor que no es de ninguna pantalla no se toca (la URL se
  // queda) y la pantalla abre la pestaña por defecto.
  await page.goto('/admin?tab=no-existe');
  await expect(tab('Actividad')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/admin\?tab=no-existe$/);
});
