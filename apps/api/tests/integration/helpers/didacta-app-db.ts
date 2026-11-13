/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Conexión a Postgres EXACTAMENTE como el runtime de producción: con el rol
 * `didacta_app` (NOSUPERUSER, NOBYPASSRLS), que es el único con el que RLS
 * filtra de verdad. Con el usuario administrador del compose (superusuario)
 * las policies existen pero no se aplican, y un test «verde» no prueba nada.
 *
 * Mismo procedimiento que `rls-isolation-didacta-app.integration.test.ts` y
 * que el entrypoint real: rls.sql, grants.sql y una contraseña conocida.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@didacta/database';

export const ADMIN_DATABASE_URL = process.env['DATABASE_URL'];

const PG_CONTAINER = process.env['RLS_TEST_PG_CONTAINER'] ?? 'didacta-postgres-test';
const PG_USER = process.env['RLS_TEST_PG_USER'] ?? 'didacta_test';
const PG_DB = process.env['RLS_TEST_PG_DB'] ?? 'didacta_test';
const APP_PASSWORD = process.env['RLS_TEST_APP_PASSWORD'] ?? 'rls_test_didacta_app_pw';

const REPO_ROOT = resolve(__dirname, '../../../../..');

/**
 * Aplica un .sql con `docker exec … psql -f -`, igual que el entrypoint.
 * `user` permite correrlo con otro rol (p. ej. `didacta_app`, sin superuser ni
 * BYPASSRLS) para probar que el fichero respeta la RLS forzada.
 */
export function applySqlFileViaPsql(relPath: string, opts: { user?: string } = {}): void {
  const sql = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      PG_CONTAINER,
      'psql',
      '-U',
      opts.user ?? PG_USER,
      '-d',
      PG_DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ],
    { input: sql, stdio: ['pipe', 'pipe', 'inherit'] },
  );
}

export function didactaAppUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = 'didacta_app';
  url.password = APP_PASSWORD;
  return url.toString();
}

/**
 * Deja la base con RLS y grants aplicados y devuelve dos clientes: el
 * administrador (para sembrar y para mirar el resultado saltándose RLS) y la
 * URL del rol de aplicación.
 */
export async function prepareDidactaAppRole(): Promise<{ admin: PrismaClient; appUrl: string }> {
  if (!ADMIN_DATABASE_URL) throw new Error('DATABASE_URL no definida');
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_DATABASE_URL } } });
  await admin.$connect();
  applySqlFileViaPsql('packages/database/prisma/rls.sql');
  applySqlFileViaPsql('packages/database/prisma/grants.sql');
  await admin.$executeRawUnsafe(
    `ALTER ROLE didacta_app PASSWORD '${APP_PASSWORD.replace(/'/g, "''")}'`,
  );
  return { admin, appUrl: didactaAppUrl(ADMIN_DATABASE_URL) };
}
