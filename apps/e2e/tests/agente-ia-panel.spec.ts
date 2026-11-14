/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Panel «Hazlo más rápido con tu agente de IA» + servidor MCP del aula, de
 * punta a punta y en un aula NUEVA del modo sencillo:
 *
 *  1. La creadora ve el panel al crear lecciones, con el título REAL de su
 *     curso en el ejemplo; crea la clave (se enseña una vez), y el comando de
 *     Claude Code y la config de Codex llevan la URL del MCP de SU aula y la
 *     clave; copiar deja eso mismo en el portapapeles.
 *  2. Con ESA clave, un cliente MCP (JSON-RPC por la web, como un agente)
 *     crea un curso con lecciones, y la creadora lo ve en su aula.
 *  3. Plegado se recuerda tras recargar. Revocar la clave cierra el MCP.
 *  4. Solo en zonas de gestión: la creadora (admin) NO lo ve en la comunidad
 *     ni en los espacios, y una alumna no lo ve nunca. En «Empieza aquí»
 *     tampoco sale.
 *  5. A 390 px: botón en la página y hoja inferior, sin desbordar.
 */

const WEB_PORT = Number(new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3010').port || 3010);

/** Petición JSON-RPC al MCP del aula a través de la web (rewrite de Next), como un agente. */
function mcp(
  host: string,
  key: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: WEB_PORT,
        path: '/api/v1/mcp',
        method: 'POST',
        headers: {
          Host: `${host}:${WEB_PORT}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${key}`,
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let txt = '';
        res.on('data', (c) => (txt += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, json: txt ? JSON.parse(txt) : null }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function toolText(r: { json: Record<string, unknown> | null }): Record<string, unknown> {
  const result = r.json?.['result'] as { content: Array<{ text: string }>; isError?: boolean };
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/**
 * Primer acceso hecho por la API (contraseña por su enlace, perfil y
 * bienvenida cerrados): el panel no es parte de ese recorrido, que ya cubre
 * `modo-sencillo-de-cero.spec.ts`. Devuelve nada; la persona entra luego por
 * `/signin` como cualquier día.
 */
async function primerAcceso(tenant: FreshTenant, email: string, resetToken: string, name: string) {
  await apiAs(tenant.host, '/api/v1/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, newPassword: tenant.password },
  });
  const { tokens } = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signin',
    { method: 'POST', body: { tenantSlug: tenant.slug, email, password: tenant.password } },
  );
  await apiAs(tenant.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer: tokens.accessToken,
    body: { name, avatarUrl: '/api/v1/storage/file/avatars/e2e-harness.png' },
  });
  await apiAs(tenant.host, '/api/v1/me/onboarding/complete', {
    method: 'POST',
    bearer: tokens.accessToken,
  });
}

async function signin(page: Page, tenant: FreshTenant, email: string) {
  await page.goto(`${tenant.base}/signin`);
  await page.locator('input[autocomplete="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(tenant.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
}

/** Aula nueva con el alta en 3 preguntas hecha y la creadora dentro. */
async function aulaConCreadora(browser: Browser, viewport = { width: 1440, height: 900 }) {
  const tenant = await freshTenant(`agente${Date.now().toString(36)}`, true);
  const { tokens } = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signin',
    {
      method: 'POST',
      body: {
        tenantSlug: tenant.slug,
        email: `operador@${tenant.slug}.test`,
        password: tenant.password,
      },
    },
  );
  const alta = await apiAs<{ offer: { courseId: string } }>(
    tenant.host,
    '/api/v1/admin/simple-mode/quick-start',
    {
      method: 'POST',
      bearer: tokens.accessToken,
      body: {
        academyName: 'Morning Pour',
        offer: 'course',
        title: 'Espresso at Home',
        amountCents: 4900,
        currency: 'eur',
        locale: 'es',
      },
    },
  );
  const ctx = await browser.newContext({
    locale: 'es-ES',
    viewport,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  const page = await ctx.newPage();
  const resetToken = new URL(tenant.setPasswordUrl).searchParams.get('token')!;
  await primerAcceso(tenant, tenant.creatorEmail, resetToken, 'Morning Pour');
  await signin(page, tenant, tenant.creatorEmail);
  return { tenant, operador: tokens.accessToken, courseId: alta.offer.courseId, ctx, page };
}

/** Alumna real del aula, con su contraseña puesta y su primer acceso ya hecho. */
async function alumna(tenant: FreshTenant, operador: string) {
  const email = `alumna@${tenant.slug}.test`;
  await apiAs(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer: operador,
    body: { email, role: 'alumno' },
  });
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${hash}', now() + interval '1 day', now() ` +
      `FROM "user" u WHERE u.email = '${email}'`,
  );
  await primerAcceso(tenant, email, token, 'Alumna');
  return email;
}

const AGENTES = [
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['hermes', 'Hermes'],
  ['grok', 'Grok'],
  ['cursor', 'Cursor'],
  ['vscode', 'VS Code'],
] as const;

/**
 * Cada pestaña del panel enseña el logo de su herramienta: un SVG del propio
 * aula (`/agents/<id>.svg`, nada de CDNs) que CARGA de verdad (una imagen
 * rota da `naturalWidth` 0), a 16 px, decorativo (el nombre que se lee es el
 * de la pestaña) y con el nombre entero al lado, sin cortarse.
 */
async function logosEnLasPestanas(scope: Locator) {
  for (const [id, nombre] of AGENTES) {
    const tab = scope.getByRole('tab', { name: nombre, exact: true });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('data-testid', `agente-ia-tab-${id}`);
    const logo = tab.getByTestId(`agente-ia-logo-${id}`);
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('src', `/agents/${id}.svg`);
    await expect(logo).toHaveAttribute('alt', '');
    await expect
      .poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    const caja = (await logo.boundingBox())!;
    expect([Math.round(caja.width), Math.round(caja.height)]).toEqual([16, 16]);
    const etiqueta = tab.getByText(nombre, { exact: true });
    expect(await etiqueta.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
}

test('agente de IA: panel al crear lecciones, clave, comandos y un agente crea un curso de verdad', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { tenant, courseId, ctx, page } = await aulaConCreadora(browser);

  // ── En «Empieza aquí» no hay panel: no es una pantalla de creación ──────
  await page.goto(`${tenant.base}/start`);
  await expect(page.getByTestId('empieza-aqui')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('agente-ia-panel')).toHaveCount(0);

  // ── Al crear lecciones sí, con el título real del curso ────────────────
  await page.goto(`${tenant.base}/studio/courses/${courseId}`);
  await expect(page.getByTestId('editor-sencillo')).toBeVisible({ timeout: 20_000 });
  const panel = page.getByTestId('agente-ia-panel');
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole('heading', { name: 'Hazlo más rápido con tu agente de IA' }),
  ).toBeVisible();
  await expect(panel.getByTestId('agente-ia-ejemplo')).toContainText('«Espresso at Home»');
  // El panel no tapa el editor: queda a su derecha.
  const editor = await page.getByTestId('editor-sencillo').boundingBox();
  const caja = await panel.boundingBox();
  expect(editor && caja && editor.x + editor.width <= caja.x).toBe(true);

  // Cada pestaña lleva el logo de su herramienta, servido por el aula, y el
  // nombre entero al lado.
  await logosEnLasPestanas(panel);

  // Antes de crear la clave, el comando lleva el marcador.
  await expect(panel.getByTestId('agente-ia-codigo')).toContainText('TU_CLAVE');

  // ── Crear la clave: se enseña una vez y entra en los comandos ──────────
  await panel.getByTestId('agente-ia-crear-clave').click();
  const claveEl = panel.getByTestId('agente-ia-clave');
  await expect(claveEl).toContainText(/^lmsk_/);
  const clave = (await claveEl.textContent())!.trim();
  await expect(panel.getByText('Cópiala ahora: solo se enseña esta vez.')).toBeVisible();

  const mcpUrl = `${tenant.base}/api/v1/mcp`;
  const claude = panel.getByTestId('agente-ia-codigo');
  await expect(claude).toHaveText(
    `claude mcp add --transport http --scope user ${tenant.slug} ${mcpUrl} --header "Authorization: Bearer ${clave}"`,
  );
  // Copiar deja en el portapapeles exactamente ese comando.
  await claude.locator('xpath=..').getByTestId('agente-ia-copiar').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await claude.textContent(),
  );

  // Otra pestaña: Codex, con la config de su fichero.
  await panel.getByTestId('agente-ia-tab-codex').click();
  await expect(panel.getByTestId('agente-ia-codigo')).toHaveText(
    [
      `[mcp_servers.${tenant.slug}]`,
      `url = "${mcpUrl}"`,
      `http_headers = { "Authorization" = "Bearer ${clave}" }`,
    ].join('\n'),
  );
  await expect(panel.getByText('codex mcp list')).toBeVisible();

  // Grok tiene dos guías del mismo dominio: cada enlace dice adónde va.
  await panel.getByTestId('agente-ia-tab-grok').click();
  await expect(panel.getByRole('link', { name: /docs\.x\.ai\/grok-bot/ })).toBeVisible();
  await expect(panel.getByRole('link', { name: /docs\.x\.ai\/build/ })).toBeVisible();

  // ── Con ESA clave, un agente (cliente MCP) crea un curso con lecciones ──
  const init = await mcp(tenant.host, clave, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e' } },
  });
  expect(init.status).toBe(200);
  // La palabra con la que la interfaz llama a la academia, en el idioma del
  // aula (aquí español): el agente la usa al hablar con la persona.
  expect((init.json?.['result'] as { instructions: string }).instructions).toContain(
    `In this academy's language the academy is called "academia"`,
  );
  const tools = await mcp(tenant.host, clave, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (tools.json?.['result'] as { tools: Array<{ name: string }> }).tools.map(
    (t) => t.name,
  );
  expect(names).toEqual(expect.arrayContaining(['create_course', 'create_lesson']));
  const curso = toolText(
    await mcp(tenant.host, clave, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'create_course', arguments: { title: 'Latte Art Basics' } },
    }),
  );
  for (const [i, title] of ['Milk texture', 'The heart', 'The rosetta'].entries()) {
    toolText(
      await mcp(tenant.host, clave, {
        jsonrpc: '2.0',
        id: 10 + i,
        method: 'tools/call',
        params: {
          name: 'create_lesson',
          arguments: { courseId: curso['id'], title, type: 'text', text: `${title}: practice.` },
        },
      }),
    );
  }
  // La creadora lo ve en su aula, en borrador, con sus lecciones en orden.
  await page.goto(`${tenant.base}/studio/courses/${String(curso['id'])}`);
  await expect(page.getByTestId('editor-sencillo')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('1. Milk texture')).toBeVisible();
  await expect(page.getByText('3. The rosetta')).toBeVisible();

  // ── Plegar: queda una pestaña, y se recuerda al recargar ───────────────
  await page.getByTestId('agente-ia-ocultar').click();
  await expect(page.getByTestId('agente-ia-panel')).toHaveCount(0);
  await expect(page.getByTestId('agente-ia-plegado')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('editor-sencillo')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('agente-ia-plegado')).toBeVisible();
  await expect(page.getByTestId('agente-ia-panel')).toHaveCount(0);
  // Tras recargar, la clave NO vuelve a enseñarse: solo se avisa de que hay una.
  await page.getByTestId('agente-ia-plegado').click();
  await expect(page.getByTestId('agente-ia-panel')).toBeVisible();
  await expect(page.getByTestId('agente-ia-clave')).toHaveCount(0);
  await expect(page.getByTestId('agente-ia-panel')).toContainText('1 clave activa');

  // ── Revocar desde el panel cierra el MCP a esa clave ──────────────────
  await page.getByTestId('agente-ia-crear-clave').click();
  const segunda = (await page.getByTestId('agente-ia-clave').textContent())!.trim();
  expect((await mcp(tenant.host, segunda, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(
    200,
  );
  await page.getByTestId('agente-ia-panel').getByRole('button', { name: 'Revocar' }).click();
  await expect(page.getByTestId('agente-ia-clave')).toHaveCount(0);
  expect((await mcp(tenant.host, segunda, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(
    401,
  );
  // La primera, que no se revocó, sigue sirviendo (el 401 no es «todo falla»).
  expect((await mcp(tenant.host, clave, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(
    200,
  );
  await ctx.close();
});

/** Ni panel, ni pestaña plegada, ni botón del móvil. */
async function sinPanel(page: Page) {
  await expect(page.getByTestId('simple-shell')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('agente-ia-panel')).toHaveCount(0);
  await expect(page.getByTestId('agente-ia-plegado')).toHaveCount(0);
  await expect(page.getByTestId('agente-ia-movil')).toHaveCount(0);
}

test('agente de IA: solo en gestión — ni en la comunidad ni en los espacios aunque seas admin, y una alumna nunca', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { tenant, operador, page, ctx } = await aulaConCreadora(browser);
  // Un espacio real del aula (si el alta no trae ninguno, se crea uno).
  let spaces = await apiAs<Array<{ slug: string }>>(
    tenant.host,
    '/api/v1/modules/community/spaces',
    { bearer: operador },
  );
  if (spaces.length === 0) {
    await apiAs(tenant.host, '/api/v1/modules/community/spaces', {
      method: 'POST',
      bearer: operador,
      body: { slug: 'general', title: 'General' },
    });
    spaces = [{ slug: 'general' }];
  }
  const espacio = `/spaces/${spaces[0]!.slug}`;

  // Control: la creadora SÍ lo ve en la gestión de directos (la comprobación
  // de abajo discrimina: el panel existe para ella).
  await page.goto(`${tenant.base}/studio/live`);
  await expect(page.getByTestId('agente-ia-panel')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('agente-ia-panel').locator('[data-screen="live"]')).toBeVisible();
  // Y NO en la comunidad ni en los espacios, aunque sea la administradora.
  for (const ruta of ['/community', espacio]) {
    await page.goto(`${tenant.base}${ruta}`);
    await sinPanel(page);
  }
  await ctx.close();

  const email = await alumna(tenant, operador);
  const actx = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1440, height: 900 },
  });
  const a = await actx.newPage();
  await signin(a, tenant, email);
  for (const ruta of ['/community', espacio, '/courses']) {
    await a.goto(`${tenant.base}${ruta}`);
    await sinPanel(a);
  }
  // Y la API tampoco le deja acuñar una clave de agente (403, no 401: tiene
  // sesión válida, le falta ser admin).
  const { tokens } = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signin',
    { method: 'POST', body: { tenantSlug: tenant.slug, email, password: tenant.password } },
  );
  await expect(
    apiAs(tenant.host, '/api/v1/agent/keys', {
      method: 'POST',
      bearer: tokens.accessToken,
      body: {},
    }),
  ).rejects.toThrow(/-> 403/);
  await actx.close();
});

test('agente de IA a 390 px: botón en la página y hoja inferior, sin tapar ni desbordar', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { tenant, courseId, page, ctx } = await aulaConCreadora(browser, {
    width: 390,
    height: 844,
  });
  await page.goto(`${tenant.base}/studio/courses/${courseId}`);
  await expect(page.getByTestId('editor-sencillo')).toBeVisible({ timeout: 20_000 });
  // En el móvil no hay columna: un botón dentro de la página.
  await expect(page.getByTestId('agente-ia-panel')).toBeHidden();
  const boton = page.getByTestId('agente-ia-movil');
  await expect(boton).toBeVisible();
  // No desborda en horizontal.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // El botón va ANTES del editor, en el flujo: no se monta encima.
  const b = (await boton.boundingBox())!;
  const e = (await page.getByTestId('editor-sencillo').boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(e.y);

  await boton.click();
  const hoja = page.getByTestId('agente-ia-hoja');
  await expect(hoja).toBeVisible();
  await expect(hoja.getByTestId('agente-ia-ejemplo')).toContainText('«Espresso at Home»');
  // También en el móvil cada pestaña lleva su logo, y con ellos nada se sale
  // de la hoja ni de la pantalla.
  await logosEnLasPestanas(hoja);
  expect(await hoja.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await hoja.getByTestId('agente-ia-tab-hermes').click();
  await expect(hoja.getByTestId('agente-ia-codigo')).toContainText('mcp_servers:');
  await hoja.getByTestId('agente-ia-ocultar').click();
  await expect(hoja).toHaveCount(0);
  await ctx.close();
});
