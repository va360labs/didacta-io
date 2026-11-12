/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'didacta-postgres-test';
const PG_USER = process.env.E2E_PG_USER ?? 'didacta_test';
const PG_DB = process.env.E2E_PG_DB ?? 'didacta_test';
const API_PORT = Number(process.env.API_PORT ?? 4000);
const WEB_PORT = Number(new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3010').port || 3010);
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'E2eAdminPassword123!';
const REPO = path.resolve(__dirname, '..', '..', '..');

export function sql(query: string): string {
  return execFileSync(
    'docker',
    ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-t', '-A', '-c', query],
    {
      encoding: 'utf8',
    },
  ).trim();
}

/** Llamada a la API resolviendo el aula por su Host (como hace el navegador). */
export function apiAs<T>(
  host: string,
  p: string,
  opts: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<T> {
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
          (res.statusCode ?? 500) >= 400
            ? reject(
                new Error(`${opts.method ?? 'GET'} ${p} -> ${res.statusCode} ${txt.slice(0, 300)}`),
              )
            : resolve((txt ? JSON.parse(txt) : {}) as T),
        );
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export interface FreshTenant {
  slug: string;
  host: string;
  /** URL de la web del aula (subdominio de localhost: Chromium lo resuelve solo). */
  base: string;
  creatorEmail: string;
  password: string;
  /** Enlace de «define tu contraseña», como el del correo de bienvenida. */
  setPasswordUrl: string;
}

/**
 * Un aula NUEVA como la crea Didacta Cloud: el tenant con su dominio, en el
 * modo pedido, y una creadora `tenant_admin` sin contraseña que entra por el
 * enlace de definir contraseña. (Crear aulas por `POST /admin/tenants` exige
 * la licencia de multiaula, que el arnés local no tiene: se siembra con el
 * mismo `seed.ts` que el aula de smoke y una cuenta de operador aparte.)
 */
export async function freshTenant(slug: string, simple: boolean): Promise<FreshTenant> {
  const host = `${slug}.localhost`;
  execFileSync(
    process.execPath,
    [path.join(REPO, 'node_modules/tsx/dist/cli.mjs'), 'src/seed.ts'],
    {
      cwd: path.join(REPO, 'packages/database'),
      env: {
        ...process.env,
        BOOTSTRAP_TENANT_SLUG: slug,
        BOOTSTRAP_TENANT_NAME: slug,
        BOOTSTRAP_EMAIL: `operador@${slug}.test`,
        BOOTSTRAP_PASSWORD: PASSWORD,
        BOOTSTRAP_DOMAINS: host,
      },
      stdio: 'ignore',
    },
  );
  const op = await apiAs<{ tokens: { accessToken: string } }>(host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: slug, email: `operador@${slug}.test`, password: PASSWORD },
  });
  await apiAs(host, '/api/v1/admin/simple-mode', {
    method: 'PUT',
    bearer: op.tokens.accessToken,
    body: { enabled: simple },
  });
  const creatorEmail = `creadora@${slug}.test`;
  await apiAs(host, '/api/v1/admin/users', {
    method: 'POST',
    bearer: op.tokens.accessToken,
    body: { email: creatorEmail, role: 'tenant_admin' },
  });
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${hash}', now() + interval '1 day', now() ` +
      `FROM "user" u WHERE u.email = '${creatorEmail}'`,
  );
  const base = `http://${host}:${WEB_PORT}`;
  return {
    slug,
    host,
    base,
    creatorEmail,
    password: PASSWORD,
    setPasswordUrl: `${base}/reset-password?token=${token}`,
  };
}
