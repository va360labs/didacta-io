/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * La cadena de hashes del registro de auditoría tiene que seguir siendo LINEAL
 * aunque varias acciones del mismo tenant se graben a la vez.
 *
 * `record()` leía el último hash y luego insertaba, sin transacción: dos
 * escrituras simultáneas leían el mismo «último», se insertaban las dos con el
 * mismo `prev_hash` y `verifyChain` daba la cadena por rota para siempre (las
 * filas son append-only: una bifurcación no se puede reparar).
 *
 * Esto solo se reproduce contra un Postgres real: un doble en memoria no tiene
 * dos conexiones que puedan pisarse. Hay dos bloques:
 *
 *  1. Con la conexión de administración — lo que resuelve el lock.
 *  2. Con la app conectada como en producción tras el flip de RLS: rol
 *     `didacta_app` (NOBYPASSRLS), tablas con FORCE ROW LEVEL SECURITY y la
 *     extensión de enforcement del `PrismaModule` real. Ahí una transacción
 *     que perdiera el contexto del tenant no fallaría: leería 0 filas, daría
 *     `prev_hash = null` a todas las escrituras y rompería la cadena de otra
 *     forma, en silencio. Por eso se prueba aparte.
 *
 * REQUISITOS: `docker compose -f docker-compose.test.yml up -d`. El bloque 2
 * aplica `rls.sql` y `grants.sql` con `docker exec <contenedor> psql`, igual
 * que `rls-isolation-didacta-app.integration.test.ts` (mismas variables
 * `RLS_TEST_PG_*`).
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@didacta/database';
import { PrismaAuditLogService } from '../../src/modules/prisma-audit-log.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant, runGlobalWithoutTenant } from '../../src/tenancy/tenant-context.storage';

const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://didacta_test:didacta_test@localhost:5433/didacta_test?schema=public';

const CONCURRENT_WRITES = 25;

const entry = (tenantId: string, i: number) => ({
  tenantId,
  actorId: null,
  action: 'test.concurrent',
  resourceType: 'test',
  resourceId: `r${i}`,
  metadata: { i, etiqueta: 'concurrencia' },
});

async function crearTenant(admin: PrismaClient, prefijo: string): Promise<string> {
  const id = randomUUID();
  await admin.tenant.create({
    data: { id, slug: `${prefijo}-${id.slice(0, 8)}`, name: 'Audit race', config: {} },
  });
  return id;
}

/** Lo que tiene que cumplir una cadena de `total` filas que no se ha bifurcado. */
async function esperarCadenaLineal(admin: PrismaClient, tenantId: string, total: number) {
  const rows = await admin.auditLog.findMany({
    where: { tenantId },
    orderBy: { id: 'asc' },
    select: { prevHash: true, hash: true },
  });
  expect(rows).toHaveLength(total);
  const prevHashes = rows.map((r) => r.prevHash);
  // Ningún `prev_hash` repetido y exactamente una raíz: eso ES no bifurcarse.
  expect(new Set(prevHashes).size).toBe(total);
  expect(prevHashes.filter((h) => h === null)).toHaveLength(1);
  // Y cada fila enlaza con la inmediatamente anterior.
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash);
  }
}

describe('audit log: cadena de hashes con escrituras concurrentes', () => {
  let admin: PrismaClient;
  let svc: PrismaAuditLogService;

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_DATABASE_URL } } });
    await admin.$connect();
    svc = new PrismaAuditLogService(admin as never);
  });

  afterAll(async () => {
    await admin.$disconnect();
  });

  it(`${CONCURRENT_WRITES} escrituras simultáneas del mismo tenant dejan la cadena válida`, async () => {
    const tenant = await crearTenant(admin, 'audit-race');

    await Promise.all(
      Array.from({ length: CONCURRENT_WRITES }, (_, i) => svc.record(entry(tenant, i))),
    );

    expect(await svc.verifyChain(tenant)).toEqual({
      valid: true,
      totalEntries: CONCURRENT_WRITES,
      firstBrokenId: null,
      brokenAt: null,
    });
    await esperarCadenaLineal(admin, tenant, CONCURRENT_WRITES);
  });

  it('dos tenants escribiendo a la vez mantienen cada uno su cadena válida', async () => {
    const b = await crearTenant(admin, 'audit-race-b');
    const c = await crearTenant(admin, 'audit-race-c');

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => [
        svc.record(entry(b, i)),
        svc.record(entry(c, i)),
      ]).flat(),
    );

    expect(await svc.verifyChain(b)).toMatchObject({ valid: true, totalEntries: 10 });
    expect(await svc.verifyChain(c)).toMatchObject({ valid: true, totalEntries: 10 });
    await esperarCadenaLineal(admin, b, 10);
    await esperarCadenaLineal(admin, c, 10);
  });

  it('una cadena ESCRITA ANTES de este cambio se sigue verificando, y se continúa sin romperla', async () => {
    const tenant = await crearTenant(admin, 'audit-legacy');

    // Dos filas como las escribía el servicio antes: sin transacción ni lock.
    // La primera con el hash en el formato LEGACY (claves en orden de
    // inserción, no canónico), que `verifyChain` sigue aceptando.
    const t1 = new Date('2026-03-01T10:00:00.000Z');
    const p1 = {
      prevHash: null,
      tenantId: tenant,
      actorId: null,
      action: 'legacy.one',
      resourceType: 'test',
      resourceId: 'r-legacy-1',
      metadata: { z: 1 },
      timestamp: t1.toISOString(),
    };
    const h1 = createHash('sha256').update(JSON.stringify(p1)).digest('hex');
    await admin.auditLog.create({
      data: {
        tenantId: tenant,
        actorId: null,
        action: p1.action,
        resourceType: p1.resourceType,
        resourceId: p1.resourceId,
        metadata: p1.metadata,
        timestamp: t1,
        prevHash: null,
        hash: h1,
      },
    });
    expect(await svc.verifyChain(tenant)).toMatchObject({ valid: true, totalEntries: 1 });

    await Promise.all(Array.from({ length: 12 }, (_, i) => svc.record(entry(tenant, i))));

    expect(await svc.verifyChain(tenant)).toMatchObject({ valid: true, totalEntries: 13 });
    await esperarCadenaLineal(admin, tenant, 13);
    // La primera escritura nueva enlaza con la fila antigua.
    const segunda = await admin.auditLog.findFirst({
      where: { tenantId: tenant, action: 'test.concurrent' },
      orderBy: { id: 'asc' },
      select: { prevHash: true },
    });
    expect(segunda!.prevHash).toBe(h1);
  });

  it('ráfaga grande: ninguna entrada se pierde esperando el lock', async () => {
    const tenant = await crearTenant(admin, 'audit-burst');
    const TOTAL = 120;

    const resultados = await Promise.allSettled(
      Array.from({ length: TOTAL }, (_, i) => svc.record(entry(tenant, i))),
    );

    expect(resultados.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await svc.verifyChain(tenant)).toMatchObject({ valid: true, totalEntries: TOTAL });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bajo RLS real: la app conectada como `didacta_app`, con el PrismaModule real.
// ─────────────────────────────────────────────────────────────────────────────

const PG_CONTAINER = process.env['RLS_TEST_PG_CONTAINER'] ?? 'didacta-postgres-test';
const PG_USER = process.env['RLS_TEST_PG_USER'] ?? 'didacta_test';
const PG_DB = process.env['RLS_TEST_PG_DB'] ?? 'didacta_test';
const APP_PASSWORD = process.env['RLS_TEST_APP_PASSWORD'] ?? 'rls_test_didacta_app_pw';
const REPO_ROOT = resolve(__dirname, '../../../..');

/** Igual que el entrypoint real: los .sql se aplican con psql, no con Prisma. */
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

describe('audit log: concurrencia bajo RLS real (rol didacta_app + extensión de enforcement)', () => {
  let admin: PrismaClient;
  let moduleRef: TestingModule;
  let appPrisma: PrismaService;
  let svc: PrismaAuditLogService;
  const previousEnv = {
    DATABASE_URL: process.env['DATABASE_URL'],
    RLS_ENFORCEMENT: process.env['RLS_ENFORCEMENT'],
  };

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_DATABASE_URL } } });
    await admin.$connect();

    // Idempotente, como en el arranque real: políticas + rol de runtime.
    applySqlFileViaPsql('packages/database/prisma/rls.sql');
    applySqlFileViaPsql('packages/database/prisma/grants.sql');
    await admin.$executeRawUnsafe(
      `ALTER ROLE didacta_app PASSWORD '${APP_PASSWORD.replace(/'/g, "''")}'`,
    );

    // La app, tal y como arranca en producción: PrismaModule real (cliente
    // extendido + proxy de $transaction) conectando como didacta_app.
    const appUrl = new URL(ADMIN_DATABASE_URL);
    appUrl.username = 'didacta_app';
    appUrl.password = APP_PASSWORD;
    process.env['DATABASE_URL'] = appUrl.toString();
    process.env['RLS_ENFORCEMENT'] = 'on';
    moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
    appPrisma = moduleRef.get(PrismaService);
    await appPrisma.$connect();
    svc = new PrismaAuditLogService(appPrisma);
  }, 60_000);

  afterAll(async () => {
    await appPrisma?.$disconnect();
    await moduleRef?.close();
    await admin?.$disconnect();
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('CONTROL: la conexión es de verdad didacta_app y RLS filtra — sin contexto no ve la cadena', async () => {
    const tenant = await crearTenant(admin, 'audit-rls-control');
    await new PrismaAuditLogService(admin as never).record(entry(tenant, 0));

    const quien = await appPrisma.$queryRaw<Array<{ current_user: string }>>`SELECT current_user`;
    expect(quien[0]!.current_user).toBe('didacta_app');
    // La fila existe (la ve el admin), pero sin contexto de tenant no aparece.
    expect(await admin.auditLog.count({ where: { tenantId: tenant } })).toBe(1);
    expect(await appPrisma.auditLog.findMany({ where: { tenantId: tenant } })).toEqual([]);
    // Con contexto, sí.
    expect(
      await runAsTenant(tenant, () => appPrisma.auditLog.count({ where: { tenantId: tenant } })),
    ).toBe(1);
  });

  it(`con contexto de tenant: ${CONCURRENT_WRITES} escrituras simultáneas dejan la cadena válida`, async () => {
    const tenant = await crearTenant(admin, 'audit-rls');

    await runAsTenant(tenant, () =>
      Promise.all(
        Array.from({ length: CONCURRENT_WRITES }, (_, i) => svc.record(entry(tenant, i))),
      ),
    );

    // Si la transacción hubiera perdido el contexto, todas habrían leído 0
    // filas y nacido con prev_hash = null: 25 raíces en vez de una.
    await esperarCadenaLineal(admin, tenant, CONCURRENT_WRITES);
    expect(await runAsTenant(tenant, () => svc.verifyChain(tenant))).toMatchObject({
      valid: true,
      totalEntries: CONCURRENT_WRITES,
    });
  });

  it('acceso global sancionado (super_admin actuando sobre un tenant): también lineal', async () => {
    // Es como audita `AdminTenantsService`: fuera del contexto del tenant del
    // que mira, con el acceso marcado como sancionado.
    const tenant = await crearTenant(admin, 'audit-rls-global');

    await runGlobalWithoutTenant(() =>
      Promise.all(Array.from({ length: 15 }, (_, i) => svc.record(entry(tenant, i)))),
    );

    await esperarCadenaLineal(admin, tenant, 15);
  });

  it('dos tenants a la vez, cada uno en su contexto: ninguna fila acaba en la cadena del otro', async () => {
    const a = await crearTenant(admin, 'audit-rls-a');
    const b = await crearTenant(admin, 'audit-rls-b');

    await Promise.all([
      runAsTenant(a, () =>
        Promise.all(Array.from({ length: 10 }, (_, i) => svc.record(entry(a, i)))),
      ),
      runAsTenant(b, () =>
        Promise.all(Array.from({ length: 10 }, (_, i) => svc.record(entry(b, i)))),
      ),
    ]);

    await esperarCadenaLineal(admin, a, 10);
    await esperarCadenaLineal(admin, b, 10);
  });
});
