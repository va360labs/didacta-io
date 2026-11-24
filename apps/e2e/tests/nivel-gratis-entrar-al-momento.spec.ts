/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';
import { mailsTo, smtpForMailpit, waitForMail } from '../helpers/mailpit';

/**
 * NIVEL GRATIS: entrar sin esperar al creador.
 *
 *  1. Interruptor «Revisar a mano cada alta gratis» APAGADO (lo normal): Nora
 *     pulsa «Entrar gratis» en /join, confirma su correo con el código que le
 *     llega y crea su cuenta → «Ya estás dentro». Entra y ve el curso del
 *     nivel gratis, y no el del nivel de pago. Le llega la bienvenida y la
 *     auditoría dice que la aprobó el sistema (`via: auto`).
 *  2. Interruptor ENCENDIDO desde el editor del nivel: Iván se apunta igual
 *     (con su código) y queda PENDIENTE, sin acceso, hasta que lo aprueben.
 *
 * Control: un aula sin nivel gratis sigue con su registro como estaba (sin
 * aprobación automática).
 *
 * El correo sale por Mailpit (`E2E_MAILPIT_URL`): sin él este spec no se puede
 * hacer (el código solo viaja por correo).
 */

const CAPTURAS = process.env.E2E_CAPTURAS;
const API_PORT = Number(process.env.API_PORT ?? 4000);
const PASSWORD = 'AlumnaPrueba123!';

async function shot(page: Page, name: string) {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(CAPTURAS, `${name}.png`), fullPage: true });
}

/** Como `apiAs` pero devuelve el código y el cuerpo también si es un error. */
function rawAs(
  host: string,
  p: string,
  opts: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path: p,
        method: opts.method ?? 'GET',
        headers: {
          Host: host,
          'content-type': 'application/json',
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
          ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        },
      },
      (res) => {
        let txt = '';
        res.on('data', (c) => (txt += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: txt ? JSON.parse(txt) : {} }),
        );
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function newPage(browser: Browser, tenant: FreshTenant): Promise<Page> {
  const ctx = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1280, height: 900 },
    baseURL: tenant.base,
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  return ctx.newPage();
}

async function signinPage(page: Page, email: string, password: string) {
  await page.goto('/signin');
  await page.locator('input[autocomplete="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
}

/** Aula en modo completo, puesta en marcha, con el correo saliendo por Mailpit. */
async function aula(prefix: string): Promise<{ tenant: FreshTenant; bearer: string }> {
  const stamp = Date.now().toString(36);
  const tenant = await freshTenant(`${prefix}${stamp}`, false);
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
  const bearer = tokens.accessToken;
  await apiAs(tenant.host, '/api/v1/tenant-settings/onboarding/academy', {
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
  sql(
    `UPDATE "user" SET onboarding_completed_at = now() WHERE email = 'operador@${tenant.slug}.test'`,
  );
  await apiAs(tenant.host, '/api/v1/admin/tenant-settings/smtp', {
    method: 'PUT',
    bearer,
    body: smtpForMailpit(`hola@${tenant.slug}.example.com`, 'Taller de cerámica'),
  });
  return { tenant, bearer };
}

async function crearCurso(tenant: FreshTenant, bearer: string, title: string): Promise<string> {
  const stamp = Date.now().toString(36);
  const course = await apiAs<{ id: string }>(tenant.host, '/api/v1/modules/courses', {
    method: 'POST',
    bearer,
    body: {
      title,
      slug: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}`,
      description: `Curso ${title}.`,
      category: 'general',
    },
  });
  const mod = await apiAs<{ id: string }>(
    tenant.host,
    `/api/v1/modules/courses/${course.id}/modules`,
    { method: 'POST', bearer, body: { title: 'Primeros pasos', orderIndex: 0 } },
  );
  await apiAs(tenant.host, `/api/v1/modules/courses/modules/${mod.id}/lessons`, {
    method: 'POST',
    bearer,
    body: { title: 'Lección 1', type: 'TEXT', orderIndex: 0, content: { text: 'Hola.' } },
  });
  await apiAs(tenant.host, `/api/v1/modules/courses/${course.id}/publish`, {
    method: 'POST',
    bearer,
  });
  return course.id;
}

/** El código de 6 cifras del ÚLTIMO correo de verificación que recibió `email`. */
async function codigoDe(email: string, count = 1): Promise<string> {
  const mail = await waitForMail(email, count);
  const code = /\b(\d{6})\b/.exec(mail.Text ?? '')?.[1];
  expect(code, `código en el correo a ${email}`).toBeTruthy();
  return code!;
}

interface Tiers {
  tiers: Array<{ id: string; isFree: boolean }>;
  freeSignup: { open: boolean; manualReview: boolean };
}

test('nivel gratis: con «Revisar a mano» apagado se entra al momento; encendido, queda pendiente', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { tenant, bearer } = await aula('gratisya');
  const tenantId = sql(`SELECT id FROM tenant WHERE slug = '${tenant.slug}'`);
  const cursoGratis = await crearCurso(tenant, bearer, 'Barro sin miedo');
  const cursoPago = await crearCurso(tenant, bearer, 'Torno avanzado');
  await apiAs(tenant.host, '/api/v1/membership/admin/config', {
    method: 'PUT',
    bearer,
    body: { active: true },
  });
  await apiAs(tenant.host, '/api/v1/membership/admin/tiers', {
    method: 'POST',
    bearer,
    body: { name: 'Taller', courseIds: [cursoPago] },
  });
  await apiAs(tenant.host, '/api/v1/membership/admin/tiers', {
    method: 'POST',
    bearer,
    body: { name: 'Gratis', isFree: true, courseIds: [cursoGratis] },
  });
  let niveles = await apiAs<Tiers>(tenant.host, '/api/v1/membership/admin/tiers', { bearer });
  expect(niveles.freeSignup).toEqual({ moduleEnabled: true, open: true, manualReview: false });
  // La política del registro gratis pasa a verificar el correo con código.
  const politica = await apiAs<{ configured: boolean; verifiers: string[]; autoApprove: boolean }>(
    tenant.host,
    '/api/v1/modules/member-registration/config',
  );
  expect(politica).toMatchObject({ configured: true, verifiers: ['otp'], autoApprove: true });

  // ── 1. Nora entra gratis desde /join, sin esperar a nadie ────────────────
  const nora = `nora.${tenant.slug}@example.com`;
  const pNora = await newPage(browser, tenant);
  await pNora.goto('/join');
  await expect(pNora.getByTestId('nivel-gratis-nota')).toContainText('entras al momento', {
    timeout: 30_000,
  });
  await pNora.getByTestId('nivel-gratis-entrar').click();
  await pNora.waitForURL(/\/member-registration/, { timeout: 30_000 });
  await pNora.locator('#ins-email').fill(nora);
  await pNora.getByRole('button', { name: 'Enviar código' }).click();
  await pNora.locator('#ins-otp').fill(await codigoDe(nora));
  await pNora.getByRole('button', { name: 'Verificar' }).click();
  await pNora.getByRole('button', { name: 'Continuar' }).click();
  await pNora.locator('#ins-name').fill('Nora Prueba');
  await pNora.locator('#ins-password').fill(PASSWORD);
  await shot(pNora, '01-gratis-crear-cuenta');
  await pNora.getByRole('button', { name: 'Crear mi cuenta' }).click();
  await expect(pNora.getByTestId('inscripcion-dentro')).toContainText('Ya estás dentro', {
    timeout: 20_000,
  });
  await shot(pNora, '02-gratis-ya-estas-dentro');
  await pNora.getByTestId('inscripcion-entrar').click();
  await pNora.waitForURL(/\/signin/);

  expect(sql(`SELECT status FROM "user" WHERE email = '${nora}'`)).toBe('ACTIVE');
  expect(
    sql(
      `SELECT metadata->>'via' FROM audit_log WHERE tenant_id = '${tenantId}' ` +
        `AND action = 'member.approved' AND metadata->>'email' = '${nora}'`,
    ),
  ).toBe('auto');
  // Código + bienvenida; al aprobador no se le avisa de nada.
  await expect.poll(async () => (await mailsTo(nora)).length, { timeout: 30_000 }).toBe(2);

  const sesion = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signin',
    { method: 'POST', body: { tenantSlug: tenant.slug, email: nora, password: PASSWORD } },
  );
  const matriculas = new Map(
    (
      await apiAs<Array<{ courseId: string; status: string }>>(
        tenant.host,
        '/api/v1/modules/learning/me/enrollments',
        { bearer: sesion.tokens.accessToken },
      )
    ).map((e) => [e.courseId, e.status]),
  );
  expect(matriculas.get(cursoGratis)).toBe('ACTIVE');
  expect(matriculas.get(cursoPago)).toBeUndefined();

  // ── 2. La creadora enciende «Revisar a mano cada alta gratis» ────────────
  const creadora = await newPage(browser, tenant);
  await signinPage(creadora, `operador@${tenant.slug}.test`, tenant.password);
  await creadora.goto('/admin/membership');
  const interruptor = creadora.getByTestId('nivel-gratis-revision-manual');
  await expect(interruptor).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
  await interruptor.click();
  await expect(interruptor).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
  await shot(creadora, '03-creadora-revisar-a-mano');
  niveles = await apiAs<Tiers>(tenant.host, '/api/v1/membership/admin/tiers', { bearer });
  expect(niveles.freeSignup.manualReview).toBe(true);
  // /join ya no promete entrar al momento.
  await creadora.goto('/join');
  await expect(creadora.getByTestId('nivel-gratis-nota')).toContainText(
    'en cuanto el aula te da paso',
    { timeout: 30_000 },
  );

  const ivan = `ivan.${tenant.slug}@example.com`;
  expect(
    (
      await rawAs(tenant.host, '/api/v1/modules/member-registration/otp/request', {
        method: 'POST',
        body: { email: ivan },
      })
    ).status,
  ).toBe(200);
  const verificado = await rawAs(tenant.host, '/api/v1/modules/member-registration/otp/verify', {
    method: 'POST',
    body: { email: ivan, code: await codigoDe(ivan) },
  });
  expect(verificado.status).toBe(200);
  const alta = await rawAs(tenant.host, '/api/v1/modules/member-registration/register', {
    method: 'POST',
    body: {
      name: 'Iván Prueba',
      password: PASSWORD,
      verificationToken: verificado.body['verificationToken'],
    },
  });
  expect(alta.status).toBe(201);
  expect(alta.body['status']).toBe('PENDING');
  expect(sql(`SELECT status FROM "user" WHERE email = '${ivan}'`)).toBe('PENDING');
  const intento = await rawAs(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: tenant.slug, email: ivan, password: PASSWORD },
  });
  expect(intento.status).toBeGreaterThanOrEqual(400);
});

test('aula sin nivel gratis: su registro sigue igual (sin aprobación automática)', async () => {
  test.setTimeout(120_000);
  const { tenant, bearer } = await aula('sinnivelgratis');
  // Registro gratis encendido a mano, como antes de los niveles.
  await apiAs(tenant.host, '/api/v1/admin/modules/mod.member-registration/enable', {
    method: 'POST',
    bearer,
  }).catch(() => undefined);
  await apiAs(tenant.host, '/api/v1/tenant-settings/member-registration/verification', {
    method: 'PUT',
    bearer,
    body: { value: { enabled: true, verifiers: ['otp'] }, isSecret: false },
  });
  const politica = await apiAs<{ autoApprove: boolean; verifiers: string[] }>(
    tenant.host,
    '/api/v1/modules/member-registration/config',
  );
  expect(politica).toMatchObject({ verifiers: ['otp'], autoApprove: false });

  const leo = `leo.${tenant.slug}@example.com`;
  await apiAs(tenant.host, '/api/v1/modules/member-registration/otp/request', {
    method: 'POST',
    body: { email: leo },
  });
  const verificado = await apiAs<{ verificationToken: string }>(
    tenant.host,
    '/api/v1/modules/member-registration/otp/verify',
    { method: 'POST', body: { email: leo, code: await codigoDe(leo) } },
  );
  const alta = await apiAs<{ status: string }>(
    tenant.host,
    '/api/v1/modules/member-registration/register',
    {
      method: 'POST',
      body: { name: 'Leo', password: PASSWORD, verificationToken: verificado.verificationToken },
    },
  );
  expect(alta.status).toBe('PENDING');
  expect(sql(`SELECT status FROM "user" WHERE email = '${leo}'`)).toBe('PENDING');
});
