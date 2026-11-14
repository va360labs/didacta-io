/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { freshTenant, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Limitador propio del acceso, por cuenta: 10 intentos fallidos por correo en
 * 15 minutos (defaults). Hasta ahora el login solo tenía el cupo público
 * general por IP, compartido con todo lo demás, y ningún bloqueo por cuenta.
 *
 * El cupo por IP del acceso lo prueban los unitarios y la integración con
 * Redis: aquí todo sale de la misma IP y el arnés lo sube (`e2e-env.sh`).
 */

const API_PORT = Number(process.env.API_PORT ?? 4000);
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'E2eAdminPassword123!';

const MENSAJE = {
  'es-ES': {
    boton: 'Entrar',
    texto: 'Demasiados intentos. Por seguridad, espera 15 min y vuelve a probar.',
  },
  'en-US': {
    boton: 'Sign in',
    texto: 'Too many attempts. For your security, wait 15 min and try again.',
  },
  'pt-BR': {
    boton: 'Entrar',
    texto: 'Muitas tentativas. Por segurança, aguarde 15 min e tente novamente.',
  },
} as const;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

function signin(t: FreshTenant, email: string, password: string): Promise<Res> {
  const data = JSON.stringify({ tenantSlug: t.slug, email, password });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path: '/api/v1/auth/signin',
        method: 'POST',
        headers: {
          Host: t.host,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let txt = '';
        res.on('data', (c) => (txt += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: txt ? (JSON.parse(txt) as Record<string, unknown>) : {},
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function diezFallos(t: FreshTenant, email: string): Promise<void> {
  for (let n = 0; n < 10; n += 1) {
    const r = await signin(t, email, 'contraseña-equivocada');
    expect(r.status, `intento ${n + 1} para ${email}`).toBe(401);
  }
}

test.describe('Acceso · límite de intentos por cuenta', () => {
  test.setTimeout(120_000);

  test('tras 10 fallos, el 11.º da 429 con Retry-After, exista o no el correo', async () => {
    const t = await freshTenant(`lim${Date.now().toString(36)}`, true);
    const existe = `operador@${t.slug}.test`; // la cuenta del operador del aula
    const noExiste = `nadie-${randomUUID().slice(0, 8)}@${t.slug}.test`;

    // Control: la cuenta existe y su contraseña es buena.
    expect((await signin(t, existe, PASSWORD)).status).toBe(201);

    await diezFallos(t, existe);
    await diezFallos(t, noExiste);
    const a = await signin(t, existe, 'contraseña-equivocada');
    const b = await signin(t, noExiste, 'contraseña-equivocada');

    for (const r of [a, b]) {
      expect(r.status).toBe(429);
      expect(r.body).toMatchObject({
        code: 'AUTH_RATE_LIMITED',
        message: MENSAJE['es-ES'].texto,
        params: { minutes: '15' },
      });
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(800);
    }
    // Nada en la respuesta distingue la cuenta que existe de la que no.
    const sinReloj = (r: Res) => ({ ...r.body, retryAfterSeconds: 0 });
    expect(sinReloj(a)).toEqual(sinReloj(b));
    expect(
      Math.abs(Number(a.headers['retry-after']) - Number(b.headers['retry-after'])),
    ).toBeLessThanOrEqual(5);

    // Bloqueada es bloqueada: ni con la contraseña buena, hasta que pase la ventana.
    expect((await signin(t, existe, PASSWORD)).status).toBe(429);
  });

  test('un login correcto no gasta cupo: 15 entradas seguidas de la misma cuenta', async () => {
    const t = await freshTenant(`lok${Date.now().toString(36)}`, true);
    const email = `operador@${t.slug}.test`;
    for (let n = 0; n < 15; n += 1) {
      expect((await signin(t, email, PASSWORD)).status, `entrada ${n + 1}`).toBe(201);
    }
    // Y unos fallos sueltos tras entrar tampoco bloquean (el éxito los puso a cero).
    for (let n = 0; n < 5; n += 1) {
      expect((await signin(t, email, 'mal')).status).toBe(401);
    }
    expect((await signin(t, email, PASSWORD)).status).toBe(201);
  });

  for (const locale of ['es-ES', 'en-US', 'pt-BR'] as const) {
    test(`la pantalla de acceso lo explica en su idioma (${locale})`, async ({ browser }) => {
      const t = await freshTenant(`lui${Date.now().toString(36)}`, true);
      const email = `alguien-${randomUUID().slice(0, 8)}@${t.slug}.test`;
      await diezFallos(t, email);

      const ctx = await browser.newContext({ locale });
      await ctx.addCookies([{ name: 'didacta_locale', value: locale, url: t.base }]);
      const page = await ctx.newPage();
      await page.goto(`${t.base}/signin`);
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill('otra-equivocada');
      await page.getByRole('button', { name: MENSAJE[locale].boton, exact: true }).click();
      // `getByText` y no `getByRole('alert')`: Next pinta su propio anunciador de
      // rutas con ese rol.
      await expect(page.getByText(MENSAJE[locale].texto)).toBeVisible();
      await ctx.close();
    });
  }
});
