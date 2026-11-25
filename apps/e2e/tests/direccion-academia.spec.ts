/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * DIRECCIÓN DE LA ACADEMIA: el creador cambia él solo el subdominio de su aula
 * (`<x>.<sufijo>` → `<y>.<sufijo>`) desde Ajustes, sin que intervenga nadie.
 *
 * El arnés corre con `TENANT_SUBDOMAIN_SUFFIX=localhost` (scripts/e2e-env.sh):
 * las aulas de `freshTenant` viven en `<slug>.localhost`, que Chromium
 * resuelve solo. Desde Node `*.localhost` no resuelve, así que las llamadas
 * sin navegador van a 127.0.0.1 con la cabecera Host del aula, como hace
 * `apiAs`.
 *
 * Lo que se prueba, de punta a punta (navegador → web → API → base):
 *   1. el cambio feliz desde Ajustes del modo sencillo, con la comprobación en
 *      vivo, la confirmación y la vuelta a entrar en la dirección nueva;
 *   2. la dirección vieja: sus PÁGINAS → 308 a la nueva con ruta y query, y su
 *      `/api` sigue respondiendo sin redirigir;
 *   3. reservada, ocupada y el límite de 3 cambios (y su aviso en el modo
 *      completo);
 *   4. sin la variable, ni API útil ni tarjeta.
 */

test.describe.configure({ mode: 'serial' });

const WEB_PORT = Number(new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3010').port || 3010);
const API_PORT = Number(process.env.API_PORT ?? 4000);
const SUFFIX = process.env.TENANT_SUBDOMAIN_SUFFIX ?? '';
const REPO = path.resolve(__dirname, '..', '..', '..');
const ADDRESS = '/api/v1/admin/tenant-settings/academy/address';

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const webBase = (host: string) => `http://${host}:${WEB_PORT}`;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** HTTP a 127.0.0.1 con el Host del aula, SIN seguir redirecciones. */
function raw(
  port: number,
  host: string,
  p: string,
  opts: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method: opts.method ?? 'GET',
        headers: {
          Host: port === WEB_PORT ? `${host}:${WEB_PORT}` : host,
          accept: 'application/json, text/html',
          ...(data
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
            : {}),
          ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        },
      },
      (res) => {
        let txt = '';
        res.on('data', (c) => (txt += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: txt }),
        );
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const json = <T>(r: RawResponse) => JSON.parse(r.body) as T;

/**
 * La creadora del aula lista para entrar: contraseña puesta con el enlace del
 * correo de bienvenida y las dos puertas de primer acceso (perfil y asistente
 * de la academia) cerradas por la API, por el mismo camino que la UI.
 */
async function creadoraLista(t: FreshTenant): Promise<string> {
  const token = new URL(t.setPasswordUrl).searchParams.get('token')!;
  await apiAs(t.host, '/api/v1/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: t.password },
  });
  const bearer = await tokenDe(t.host, t);
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
  return bearer;
}

async function tokenDe(host: string, t: FreshTenant): Promise<string> {
  const r = await apiAs<{ tokens: { accessToken: string } }>(host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: t.slug, email: t.creatorEmail, password: t.password },
  });
  return r.tokens.accessToken;
}

/** Entrar por la pantalla de acceso, como una persona. */
async function entrar(page: Page, base: string, t: FreshTenant): Promise<void> {
  await page.goto(`${base}/signin`);
  await page.getByLabel(/Email/).fill(t.creatorEmail);
  await page.getByLabel(/Contraseña/).fill(t.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
}

async function nuevaPagina(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 } });
  return ctx.newPage();
}

function dominios(slug: string): string {
  return sql(
    `SELECT string_agg(d.hostname || ':' || d.is_primary || ':' || d.redirect_to_primary, ',' ORDER BY d.created_at) ` +
      `FROM tenant_domain d JOIN tenant t ON t.id = d.tenant_id WHERE t.slug = '${slug}'`,
  );
}

test.beforeAll(() => {
  // Sin la variable, todo lo demás de este fichero no prueba nada: que se
  // diga claro en vez de fallar con síntomas raros.
  expect(SUFFIX, 'el arnés tiene que correr con TENANT_SUBDOMAIN_SUFFIX=localhost').toBe(
    'localhost',
  );
});

test('cambio feliz desde Ajustes del modo sencillo: comprobación en vivo, confirmación y vuelta a entrar en la nueva', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const t = await freshTenant(`dir${uniq()}`, true);
  await creadoraLista(t);
  const otra = await freshTenant(`dirotra${uniq()}`, true);
  const nueva = `${t.slug}-nueva`;
  const nuevaHost = `${nueva}.${SUFFIX}`;

  const page = await nuevaPagina(browser);
  await entrar(page, t.base, t);
  await page.goto(`${t.base}/admin/settings`);
  const tarjeta = page.getByTestId('direccion-academia');
  await expect(tarjeta).toBeVisible({ timeout: 20_000 });
  await expect(tarjeta.getByRole('heading', { name: 'Dirección de tu academia' })).toBeVisible();
  await expect(page.getByTestId('direccion-actual')).toContainText(t.host);
  await expect(tarjeta).toContainText(`.${SUFFIX}`);
  await expect(tarjeta).toContainText('Cambios que te quedan: 3 de 3 (cada 30 días).');

  const campo = page.getByTestId('direccion-input');
  const estado = page.getByTestId('direccion-estado');
  const boton = page.getByTestId('direccion-cambiar');

  await campo.fill('www');
  await expect(estado).toHaveAttribute('data-status', 'reserved');
  await expect(estado).toHaveText('Esta dirección no se puede usar. Prueba con otra.');
  await expect(boton).toBeDisabled();

  await campo.fill('ab');
  await expect(estado).toHaveAttribute('data-status', 'invalid');
  await expect(boton).toBeDisabled();

  // La de otra aula: ocupada, sin decir de quién.
  await campo.fill(otra.slug);
  await expect(estado).toHaveAttribute('data-status', 'taken');
  await expect(estado).toHaveText('Ya la usa otra academia. Prueba con otra.');
  await expect(boton).toBeDisabled();

  // Se escribe como lo haría alguien: con mayúsculas y espacios.
  await campo.fill(`${t.slug.toUpperCase()} Nueva`);
  await expect(campo).toHaveValue(nueva);
  await expect(estado).toHaveAttribute('data-status', 'available');
  await expect(estado).toHaveText('¡Está libre!');
  await expect(boton).toBeEnabled();

  await boton.click();
  const dialogo = page.getByTestId('direccion-confirmar');
  await expect(dialogo).toBeVisible();
  await expect(dialogo).toContainText(`Pasará de ${t.host} a ${nuevaHost}.`);
  await expect(dialogo).toContainText('Los enlaces antiguos seguirán funcionando');
  await expect(dialogo).toContainText(
    'Todo el mundo, tú también, tendrá que volver a entrar con su correo y su contraseña en la dirección nueva.',
  );
  await page.getByTestId('direccion-confirmar-si').click();

  await expect(page.getByTestId('direccion-hecho')).toContainText(
    `Tu academia ya está en https://${nuevaHost}.`,
  );
  // Sola, a la pantalla de acceso de la dirección NUEVA.
  await page.waitForURL(`${webBase(nuevaHost)}/signin`, { timeout: 20_000 });
  expect(await page.evaluate(() => localStorage.getItem('didacta.access_token'))).toBeNull();

  // Allí se entra con lo de siempre y la academia ya enseña su dirección nueva.
  await entrar(page, webBase(nuevaHost), t);
  await page.goto(`${webBase(nuevaHost)}/admin/settings`);
  await expect(page.getByTestId('direccion-actual')).toContainText(nuevaHost, { timeout: 20_000 });
  await expect(page.getByTestId('direccion-academia')).toContainText(
    'Cambios que te quedan: 2 de 3',
  );

  expect(dominios(t.slug)).toBe(`${t.host}:false:true,${nuevaHost}:true:false`);
  expect(
    sql(
      `SELECT count(*) FROM audit_log a JOIN tenant t ON t.id = a.tenant_id ` +
        `WHERE t.slug = '${t.slug}' AND a.action = 'academy.address.changed'`,
    ),
  ).toBe('1');
  await page.context().close();
});

test('la dirección vieja: sus páginas van con 308 a la nueva (ruta y query) y su /api sigue respondiendo', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const t = await freshTenant(`dirvieja${uniq()}`, false);
  const bearer = await creadoraLista(t);
  const nueva = `${t.slug}-ya`;
  const nuevaHost = `${nueva}.${SUFFIX}`;
  // Cambio por la API (la misma que usa la tarjeta). La web no ha visto aún
  // ninguna de las dos direcciones, así que nada viene de su caché.
  const cambio = await apiAs<{ hostname: string; previousHostname: string }>(t.host, ADDRESS, {
    method: 'PUT',
    bearer,
    body: { label: nueva },
  });
  expect(cambio).toMatchObject({ previousHostname: t.host, hostname: nuevaHost });

  // Páginas: 308 a la nueva, con la ruta y la query enteras (`?ref=` incluido).
  for (const p of ['/catalog?ref=ANA&utm_source=ig', '/signin', '/reset-password?token=abc']) {
    const r = await raw(WEB_PORT, t.host, p);
    expect(r.status, p).toBe(308);
    expect(r.headers.location, p).toBe(`${webBase(nuevaHost)}${p}`);
  }
  // Control: la nueva se sirve sin redirigir.
  const control = await raw(WEB_PORT, nuevaHost, '/catalog?ref=ANA');
  expect(control.status).toBe(200);
  expect(control.headers.location).toBeUndefined();

  // `/api` por la dirección vieja (a través de la web, como un webhook o un
  // cliente MCP registrado con ella): responde, no redirige.
  const api = await raw(WEB_PORT, t.host, ADDRESS, { bearer });
  expect(api.status).toBe(200);
  expect(json<{ hostname: string }>(api).hostname).toBe(nuevaHost);
  const publica = await raw(WEB_PORT, t.host, '/api/v1/tenancy/resolve');
  expect(publica.status).toBe(200);
  expect(json<{ known: boolean; redirectTo: string | null }>(publica)).toMatchObject({
    known: true,
    redirectTo: nuevaHost,
  });

  // Y en un navegador: se llega a la nueva con la misma ruta y query.
  const page = await nuevaPagina(browser);
  await page.goto(`${webBase(t.host)}/signin?next=%2Fcatalog&ref=ANA`);
  expect(page.url()).toBe(`${webBase(nuevaHost)}/signin?next=%2Fcatalog&ref=ANA`);
  await page.context().close();
});

test('reservada, ocupada y el límite de 3 cambios en 30 días (y su aviso en Ajustes del modo completo)', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const t = await freshTenant(`dirlim${uniq()}`, false);
  const bearer = await creadoraLista(t);
  const otra = await freshTenant(`dirlimotra${uniq()}`, false);

  const reservada = await raw(API_PORT, t.host, ADDRESS, {
    method: 'PUT',
    bearer,
    body: { label: 'support' },
  });
  expect(reservada.status).toBe(400);
  expect(json<{ code: string }>(reservada).code).toBe('ACADEMY_ADDRESS_RESERVED');

  const ocupada = await raw(API_PORT, t.host, ADDRESS, {
    method: 'PUT',
    bearer,
    body: { label: otra.slug },
  });
  expect(ocupada.status).toBe(409);
  expect(json<{ code: string }>(ocupada).code).toBe('ACADEMY_ADDRESS_TAKEN');
  // Sin decir de quién es: ni correo, ni nombre, ni id de la otra aula.
  expect(json<{ message: string }>(ocupada).message).toBe('Esa dirección ya la usa otra academia.');
  expect(ocupada.body).not.toContain(otra.creatorEmail);

  let actual = t.host;
  for (let i = 1; i <= 3; i++) {
    const r = await raw(API_PORT, actual, ADDRESS, {
      method: 'PUT',
      bearer,
      body: { label: `${t.slug}-v${i}` },
    });
    expect(r.status, r.body).toBe(200);
    actual = json<{ hostname: string }>(r).hostname;
  }
  const cuarto = await raw(API_PORT, actual, ADDRESS, {
    method: 'PUT',
    bearer,
    body: { label: `${t.slug}-v4` },
  });
  expect(cuarto.status).toBe(409);
  expect(json<{ code: string }>(cuarto).code).toBe('ACADEMY_ADDRESS_CHANGE_LIMIT');
  expect(dominios(t.slug).split(',')).toHaveLength(4);

  // En Configuración → General del modo completo: el aviso, sin campo.
  const page = await nuevaPagina(browser);
  await entrar(page, webBase(actual), t);
  await page.goto(`${webBase(actual)}/admin/settings?tab=general`);
  const tarjeta = page.getByTestId('direccion-academia');
  await expect(tarjeta).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('direccion-bloqueada')).toContainText(
    'Ya has cambiado la dirección 3 veces en los últimos 30 días.',
  );
  await expect(page.getByTestId('direccion-input')).toHaveCount(0);
  await page.context().close();
});

/**
 * Una segunda API sobre la misma base pero SIN `TENANT_SUBDOMAIN_SUFFIX`, como
 * la de cualquier instalación propia. Solo se usa para lo que esta prueba
 * necesita; la web y la API del arnés siguen siendo las de siempre.
 */
const API_SIN_VARIABLE_PORT = 4_119;

function arrancarApiSinVariable(): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    API_PORT: String(API_SIN_VARIABLE_PORT),
    PORT: String(API_SIN_VARIABLE_PORT),
  };
  delete env['TENANT_SUBDOMAIN_SUFFIX'];
  return spawn(process.execPath, ['dist/main.js'], {
    cwd: path.join(REPO, 'apps/api'),
    env,
    stdio: 'ignore',
  });
}

async function esperarSana(port: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await raw(port, 'localhost', '/healthz')
      .then((r) => r.status < 400)
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`La API sin la variable no arrancó en :${port}`);
}

/** Lleva la llamada de la tarjeta a la API sin la variable y devuelve SU respuesta. */
async function aLaApiSinVariable(route: Route, host: string): Promise<void> {
  const req = route.request();
  const url = new URL(req.url());
  const bearer = (req.headers()['authorization'] ?? '').replace(/^Bearer /, '');
  const r = await raw(API_SIN_VARIABLE_PORT, host, url.pathname + url.search, {
    method: req.method(),
    bearer,
    ...(req.postData() ? { body: JSON.parse(req.postData()!) } : {}),
  });
  await route.fulfill({
    status: r.status,
    contentType: 'application/json',
    body: r.body,
  });
}

test('sin TENANT_SUBDOMAIN_SUFFIX: la API responde 404 y la tarjeta no aparece', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const t = await freshTenant(`dirsin${uniq()}`, false);
  const bearer = await creadoraLista(t);

  const api = arrancarApiSinVariable();
  try {
    await esperarSana(API_SIN_VARIABLE_PORT, 90_000);
    for (const [method, p, body] of [
      ['GET', ADDRESS, undefined],
      ['GET', `${ADDRESS}/availability?label=libre-del-todo`, undefined],
      ['PUT', ADDRESS, { label: 'libre-del-todo' }],
    ] as const) {
      const r = await raw(API_SIN_VARIABLE_PORT, t.host, p, { method, bearer, body });
      expect(r.status, `${method} ${p}`).toBe(404);
      expect(json<{ code: string }>(r).code).toBe('ACADEMY_ADDRESS_DISABLED');
    }
    // Control: la API del arnés (CON la variable) sí la tiene.
    expect((await raw(API_PORT, t.host, ADDRESS, { bearer })).status).toBe(200);

    const page = await nuevaPagina(browser);
    await entrar(page, t.base, t);
    await page.goto(`${t.base}/admin/settings?tab=general`);
    // Control en la misma pantalla: con la variable, la tarjeta está.
    await expect(page.getByTestId('direccion-academia')).toBeVisible({ timeout: 20_000 });

    await page.route(`**${ADDRESS}**`, (route) => aLaApiSinVariable(route, t.host));
    await page.reload();
    await expect(page.getByTestId('idioma-academia')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('pagina-publica')).toBeVisible();
    await expect(page.getByTestId('direccion-academia')).toHaveCount(0);
    await page.context().close();
  } finally {
    api.kill();
  }
  expect(dominios(t.slug)).toBe(`${t.host}:true:false`);
});

test('bienvenida (modo completo): con dirección de la plataforma el resumen no ofrece dominio propio; sin ella, sí', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const t = await freshTenant(`dirbienv${uniq()}`, false);
  const bearer = await creadoraLista(t);
  // El asistente de la academia, abierto y parado en su último paso.
  await apiAs(t.host, '/api/v1/tenant-settings/onboarding/academy', {
    method: 'PUT',
    bearer,
    body: {
      value: {
        step: 'resumen',
        done: ['nombre', 'marca'],
        skipped: ['curso', 'alumnos', 'cobros', 'correo'],
        completedAt: null,
      },
      isSecret: false,
    },
  });
  const dominioPropio = /propio dominio/;

  const page = await nuevaPagina(browser);
  await entrar(page, t.base, t);
  await page.goto(`${t.base}/welcome`);
  await expect(page.getByRole('heading', { name: /^Listo, / })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(t.host).first()).toBeVisible();
  // Didacta Cloud (la instancia tiene «Dirección de tu academia»): no hay
  // dominio propio que ofrecer.
  await expect(page.getByText(dominioPropio)).toHaveCount(0);

  // Control: una instancia sin la función (la API responde 404) sí lo ofrece.
  await page.route(`**${ADDRESS}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'ACADEMY_ADDRESS_DISABLED' }),
    }),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Listo, / })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(dominioPropio)).toBeVisible();
  await page.context().close();
});
