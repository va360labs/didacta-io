/**
 * Test de aislamiento HONESTO de RLS — el flip real a `didacta_app` (F3).
 *
 * `rls-isolation.integration.test.ts` valida que las policies EXISTEN y
 * funcionan cuando algo setea el GUC a mano, pero corre con la conexión que
 * traiga `DATABASE_URL` (típicamente el usuario bootstrap/superuser) — un
 * superuser bypassea RLS igual, tenga o no el GUC seteado, así que ese test
 * no prueba el aislamiento REAL de producción.
 *
 * Este test conecta la app EXACTAMENTE como el runtime post-flip: como el rol
 * `didacta_app` (NOSUPERUSER NOBYPASSRLS, creado por grants.sql). Es la
 * verificación de que dos tenants reales quedan aislados de verdad, que el
 * WITH CHECK rechaza escrituras cross-tenant, y que el acceso global
 * sancionado (SET LOCAL ROLE didacta_super, ver rls-enforcement.extension.ts)
 * sigue funcionando bajo el rol sin bypass.
 *
 * REQUISITOS:
 * - `docker compose -f docker-compose.test.yml up -d` (o cualquier Postgres
 *   con DATABASE_URL apuntando a un rol ADMIN/superuser corriendo en un
 *   contenedor Docker alcanzable por nombre — se usa `docker exec` para
 *   aplicar rls.sql/grants.sql con psql, igual que el entrypoint real).
 * - Schema migrado (prisma db push / migrate deploy) antes de correr esto.
 *
 * SKIP: sin DATABASE_URL (mismo criterio que el resto de tests de esta carpeta).
 *
 * @see packages/database/prisma/grants.sql
 * @see apps/api/src/prisma/rls-enforcement.extension.ts
 * @see infra/docker/entrypoint.sh
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ADMIN_DATABASE_URL = process.env['DATABASE_URL'];
const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

// Mismos defaults que docker-compose.test.yml (ver .quality/handoff.md,
// receta de stack efímero de la sesión 12).
const PG_CONTAINER = process.env['RLS_TEST_PG_CONTAINER'] ?? 'didacta-postgres-test';
const PG_USER = process.env['RLS_TEST_PG_USER'] ?? 'didacta_test';
const PG_DB = process.env['RLS_TEST_PG_DB'] ?? 'didacta_test';
const APP_PASSWORD = process.env['RLS_TEST_APP_PASSWORD'] ?? 'rls_test_didacta_app_pw';

const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * Aplica un .sql vía `docker exec <container> psql -f -` — igual que el
 * entrypoint real (infra/docker/entrypoint.sh). No usamos
 * `$executeRawUnsafe` de Prisma: rls.sql/grants.sql tienen bloques
 * `DO $$ ... $$` con `;` internos que el protocolo simple de psql maneja
 * nativamente y no queremos depender de cómo el query engine de Prisma
 * fragmente un string multi-statement.
 */
function applySqlFileViaPsql(relPath: string): void {
  const sql = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      PG_CONTAINER,
      'psql',
      '-U',
      PG_USER,
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

function buildDidactaAppUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = 'didacta_app';
  url.password = APP_PASSWORD;
  return url.toString();
}

describeWithDb('RLS Isolation — conexión REAL como didacta_app (F3, flip)', () => {
  let admin: PrismaClient;
  let appDb: PrismaClient;
  let tenantA: { id: string };
  let tenantB: { id: string };

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_DATABASE_URL } } });
    await admin.$connect();

    // Idempotente — igual que en el entrypoint real: rls.sql, luego
    // grants.sql (crea/actualiza didacta_app + didacta_super + membership),
    // luego fijamos una contraseña conocida para conectar el segundo cliente.
    applySqlFileViaPsql('packages/database/prisma/rls.sql');
    applySqlFileViaPsql('packages/database/prisma/grants.sql');
    await admin.$executeRawUnsafe(
      `ALTER ROLE didacta_app PASSWORD '${APP_PASSWORD.replace(/'/g, "''")}'`,
    );

    appDb = new PrismaClient({
      datasources: { db: { url: buildDidactaAppUrl(ADMIN_DATABASE_URL!) } },
    });
    await appDb.$connect();

    tenantA = await admin.tenant.create({
      data: {
        id: randomUUID(),
        slug: `didacta-app-test-a-${Date.now()}`,
        name: 'Tenant A (didacta_app test)',
      },
    });
    tenantB = await admin.tenant.create({
      data: {
        id: randomUUID(),
        slug: `didacta-app-test-b-${Date.now()}`,
        name: 'Tenant B (didacta_app test)',
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (tenantA?.id) {
      await admin.user.deleteMany({ where: { tenantId: tenantA.id } });
      await admin.tenant.delete({ where: { id: tenantA.id } }).catch(() => {});
    }
    if (tenantB?.id) {
      await admin.user.deleteMany({ where: { tenantId: tenantB.id } });
      await admin.tenant.delete({ where: { id: tenantB.id } }).catch(() => {});
    }
    await appDb?.$disconnect();
    await admin?.$disconnect();
  });

  /** Igual patrón que withTenantContext: set_config parametrizado dentro de la tx. */
  async function withTenant<T>(tenantId: string, cb: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return appDb.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_tenant_id', $1, true)`, tenantId);
      return cb(tx as unknown as PrismaClient);
    });
  }

  it('didacta_app SIN contexto de tenant: 0 filas aunque se pida por id exacto (fail-closed real, no solo por tenantId=NULL)', async () => {
    const user = await admin.user.create({
      data: {
        id: randomUUID(),
        tenantId: tenantA.id,
        email: `nc-${Date.now()}@example.com`,
        passwordHash: 'x',
      },
    });
    const seen = await appDb.user.findMany({ where: { id: user.id } });
    expect(seen).toHaveLength(0);
    await admin.user.delete({ where: { id: user.id } });
  });

  it('tenant A no ve usuarios de tenant B conectando de verdad como didacta_app', async () => {
    const userA = await admin.user.create({
      data: {
        id: randomUUID(),
        tenantId: tenantA.id,
        email: `a-${Date.now()}@example.com`,
        passwordHash: 'x',
      },
    });
    const userB = await admin.user.create({
      data: {
        id: randomUUID(),
        tenantId: tenantB.id,
        email: `b-${Date.now()}@example.com`,
        passwordHash: 'x',
      },
    });

    const seenByA = await withTenant(tenantA.id, (tx) =>
      tx.user.findMany({ where: { id: { in: [userA.id, userB.id] } }, select: { id: true } }),
    );
    expect(seenByA.map((u) => u.id)).toEqual([userA.id]);

    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  });

  it('INSERT cross-tenant rechazado por WITH CHECK bajo didacta_app', async () => {
    const attempt = withTenant(tenantA.id, (tx) =>
      tx.user.create({
        data: {
          id: randomUUID(),
          tenantId: tenantB.id, // contexto es tenantA, pero el row dice tenantB
          email: `cross-${Date.now()}@example.com`,
          passwordHash: 'x',
        },
      }),
    );
    await expect(attempt).rejects.toThrow();
  });

  it('permite crear e insertar en el mismo tenant del contexto bajo didacta_app', async () => {
    const userId = randomUUID();
    const created = await withTenant(tenantA.id, (tx) =>
      tx.user.create({
        data: {
          id: userId,
          tenantId: tenantA.id,
          email: `same-${Date.now()}@example.com`,
          passwordHash: 'x',
        },
      }),
    );
    expect(created.id).toBe(userId);
    await admin.user.delete({ where: { id: userId } });
  });

  it('acceso global sancionado (SET LOCAL ROLE didacta_super) SIGUE viendo cross-tenant bajo didacta_app', async () => {
    // Sin esto, todo el inventario de runSanctionedGlobalAccess (auth por API
    // key, refresh token, resolución host→tenant, outbox, /setup/init)
    // devolvería 0 filas en producción bajo el rol sin BYPASSRLS — ver
    // rls-enforcement.extension.ts.
    const userA = await admin.user.create({
      data: {
        id: randomUUID(),
        tenantId: tenantA.id,
        email: `s-${Date.now()}@example.com`,
        passwordHash: 'x',
      },
    });
    const [, rows] = await appDb.$transaction([
      appDb.$executeRaw`SET LOCAL ROLE didacta_super`,
      appDb.user.findMany({ where: { id: userA.id }, select: { id: true } }),
    ]);
    expect((rows as unknown[]).length).toBe(1);
    await admin.user.delete({ where: { id: userA.id } });
  });

  it('tablas globales (sin tenant_id) son visibles bajo didacta_app sin ningún SET ROLE', async () => {
    const tenants = await appDb.tenant.findMany({
      where: { id: { in: [tenantA.id, tenantB.id] } },
    });
    expect(tenants).toHaveLength(2);
  });
});
