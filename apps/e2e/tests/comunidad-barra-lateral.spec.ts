/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser } from '@playwright/test';
import { injectSession } from '../helpers/auth';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Barra lateral de /community en un aula NUEVA en modo sencillo (inglés).
 *
 * Mezcla de Skool y del aula de VA360: tarjeta de la academia (titular,
 * miembros · en línea · admins, caras), próximas citas, ranking del mes, últimos
 * comentarios y el pie «Powered by Didacta». Todo con datos reales sembrados por
 * la API (los puntos salen del bus de verdad: publicar y comentar puntúan).
 *
 * Controles: el botón de ajustes solo lo ve quien administra; un aula sin
 * actividad no pinta ranking, comentarios ni titular, y no enseña nada de la
 * otra; en el móvil la barra va plegada arriba y no ensancha la página.
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

const PASSWORD = 'E2eTestPassword123!';
const HEADLINE = 'Café-quality coffee at home, one cup at a time.';

let aula: FreshTenant;
let vacia: FreshTenant;
let operador: Auth;
let priya: Auth;
let leo: Auth;
let solo: Auth;
let postId: string;
let commentId: string;

async function signinAs(t: FreshTenant, email: string, password: string): Promise<Auth> {
  return apiAs<Auth>(t.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: t.slug, email, password },
  });
}

/** La cuenta en inglés (el aula es inglesa) y su sesión ya con ese idioma. */
async function enIngles(t: FreshTenant, a: Auth, password: string): Promise<Auth> {
  await apiAs(t.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer: a.tokens.accessToken,
    body: { locale: 'en-US' },
  });
  return signinAs(t, a.user.email, password);
}

async function alumno(t: FreshTenant, key: string, name: string): Promise<Auth> {
  const a = await apiAs<Auth>(t.host, '/api/v1/auth/signup', {
    method: 'POST',
    body: { tenantSlug: t.slug, email: `${key}@example.com`, password: PASSWORD, name },
  });
  await apiAs(t.host, '/api/v1/me/onboarding/complete', {
    method: 'POST',
    bearer: a.tokens.accessToken,
    body: {},
  }).catch(() => undefined);
  return enIngles(t, a, PASSWORD);
}

async function abrir(browser: Browser, t: FreshTenant, auth: Auth, width: number, height: number) {
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width, height } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'en-US', url: t.base }]);
  const page = await ctx.newPage();
  await page.goto(`${t.base}/signin`);
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...auth.user, onboardingCompletedAt: new Date().toISOString() },
  });
  await page.goto(`${t.base}/community`);
  return { ctx, page };
}

function tenantId(slug: string): string {
  return sql(`SELECT id FROM tenant WHERE slug = '${slug}'`);
}

test.describe('comunidad · barra lateral (modo sencillo)', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const stamp = Date.now().toString(36);
    aula = await freshTenant(`barra${stamp}`, true);
    vacia = await freshTenant(`vacia${stamp}`, true);
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
      body: { signinHeadline: HEADLINE },
    });

    priya = await alumno(aula, `priya-${stamp}`, 'Priya Nair');
    leo = await alumno(aula, `leo-${stamp}`, 'Leo Martins');
    solo = await alumno(vacia, `solo-${stamp}`, 'Solo Student');
    const post = await apiAs<{ id: string }>(aula.host, '/api/v1/modules/community/posts', {
      method: 'POST',
      bearer: priya.tokens.accessToken,
      body: {
        title: 'Which grinder for a small budget?',
        body: 'Hand or electric?',
        tags: ['general'],
      },
    });
    postId = post.id;
    const c = await apiAs<{ id: string }>(
      aula.host,
      `/api/v1/modules/community/posts/${postId}/comments`,
      {
        method: 'POST',
        bearer: leo.tokens.accessToken,
        body: { body: 'A hand burr grinder beats any cheap blade grinder.' },
      },
    );
    commentId = c.id;

    // Los puntos llegan por el bus (asíncrono): se espera al libro antes de
    // pedir la barra, que se cachea unos segundos por aula.
    const id = tenantId(aula.slug);
    await expect
      .poll(
        () =>
          Number(
            sql(`SELECT count(*) FROM mod_gamification_ledger_entry WHERE tenant_id = '${id}'`),
          ),
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(2);
  });

  test('alumno a 1440: tarjeta, ranking, comentarios y pie, sin botón de ajustes', async ({
    browser,
  }) => {
    const { ctx, page } = await abrir(browser, aula, priya, 1440, 900);
    const barra = page.getByTestId('community-sidebar');
    await expect(barra).toBeVisible({ timeout: 30_000 });
    // En escritorio no hay fila plegada.
    await expect(page.getByTestId('community-sidebar-mobile')).toHaveCount(0);

    const tarjeta = barra.getByTestId('community-academy-card');
    await expect(tarjeta.getByRole('heading', { name: 'Morning Pour E2E' })).toBeVisible();
    await expect(tarjeta.getByTestId('academy-description')).toHaveText(HEADLINE);
    // Dominio local (*.localhost): no se enseña como URL para compartir.
    await expect(tarjeta.getByTestId('academy-host')).toHaveCount(0);

    const total = sql(
      `SELECT count(*) FROM "user" WHERE tenant_id = '${tenantId(aula.slug)}' AND status = 'ACTIVE' AND deleted_at IS NULL`,
    );
    await expect(tarjeta.getByTestId('academy-members')).toContainText(total);
    await expect(tarjeta.getByTestId('academy-members')).toContainText('Members');
    // Quien mira está en línea; y hay dos admins (operador y creadora).
    await expect(tarjeta.getByTestId('academy-online')).toContainText('Online');
    await expect(tarjeta.getByTestId('academy-admins')).toContainText('2');
    await expect(tarjeta.getByTestId('academy-settings')).toHaveCount(0);

    const ranking = barra.getByTestId('community-leaderboard');
    await expect(ranking.getByRole('heading', { name: 'Leaderboard · this month' })).toBeVisible();
    await expect(ranking.getByRole('listitem').first()).toContainText('Priya Nair');
    await expect(ranking.getByRole('listitem').first()).toContainText('+10');
    await expect(ranking.getByRole('link', { name: 'See the full leaderboard' })).toHaveAttribute(
      'href',
      '/leaderboard',
    );

    const comentarios = barra.getByTestId('community-recent-comments');
    await expect(comentarios).toContainText('Leo Martins');
    await expect(comentarios).toContainText('A hand burr grinder beats any cheap blade grinder.');
    await expect(comentarios).toContainText('on “Which grinder for a small budget?”');

    const pie = page.getByTestId('powered-by-didacta');
    await expect(pie).toHaveText('Powered by Didacta');
    await expect(pie).toHaveAttribute('href', 'https://didacta.io/en');

    // El comentario abre el post en el modal del feed (sin navegar) con ese
    // comentario enfocado: su caja de respuesta abierta.
    await comentarios.getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(`/community/${postId}$`));
    const dialogo = page.getByRole('dialog');
    await expect(dialogo).toContainText('Which grinder for a small budget?');
    await expect(dialogo.locator(`[id="comment-${commentId}"] textarea`)).toBeVisible();
    // El feed sigue montado debajo: sin recarga de la página.
    await expect(page.getByTestId('community-sidebar')).toBeVisible();
    await ctx.close();
  });

  test('admin a 1440: ve «Academy settings», que lleva a los ajustes', async ({ browser }) => {
    const { ctx, page } = await abrir(browser, aula, operador, 1440, 900);
    const ajustes = page.getByTestId('academy-settings');
    await expect(ajustes).toBeVisible({ timeout: 30_000 });
    await expect(ajustes).toHaveText('Academy settings');
    await expect(ajustes).toHaveAttribute('href', '/admin/settings');
    await ctx.close();
  });

  test('alumno a 390: la barra va plegada arriba y no ensancha la página', async ({ browser }) => {
    const { ctx, page } = await abrir(browser, aula, priya, 390, 844);
    const fila = page.getByTestId('community-sidebar-mobile');
    await expect(fila).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('community-sidebar')).toHaveCount(0);
    const boton = fila.getByRole('button', { name: /members/ });
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('community-academy-card')).toHaveCount(0);

    // Arriba del feed: antes que «Write something».
    const filaY = (await fila.boundingBox())!.y;
    const escribirY = (await page.getByTestId('escribe-algo').boundingBox())!.y;
    expect(filaY).toBeLessThan(escribirY);

    await boton.click();
    await expect(boton).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('community-academy-card')).toBeVisible();
    await expect(page.getByTestId('community-leaderboard')).toBeVisible();
    await expect(page.getByTestId('academy-settings')).toHaveCount(0);

    const ancho = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(ancho).toBeLessThanOrEqual(390);
    await ctx.close();
  });

  test('aula sin actividad: sin ranking, comentarios ni titular, y nada de la otra aula', async ({
    browser,
  }) => {
    const { ctx, page } = await abrir(browser, vacia, solo, 1440, 900);
    const barra = page.getByTestId('community-sidebar');
    await expect(barra.getByTestId('community-academy-card')).toBeVisible({ timeout: 30_000 });
    // Las citas (bloque propio) sí: dicen que no hay nada programado.
    await expect(barra.getByText('Coming up')).toBeVisible();
    await expect(barra.getByTestId('community-leaderboard')).toHaveCount(0);
    await expect(barra.getByTestId('community-recent-comments')).toHaveCount(0);
    await expect(barra.getByTestId('academy-description')).toHaveCount(0);
    await expect(barra).not.toContainText('Morning Pour E2E');
    await expect(barra).not.toContainText('Priya Nair');
    await expect(barra).not.toContainText(HEADLINE);
    await ctx.close();
  });
});
