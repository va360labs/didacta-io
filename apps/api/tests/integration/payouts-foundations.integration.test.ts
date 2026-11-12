/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Cimientos de mod.payouts contra Postgres de verdad (etapa E1 del plan de
 * cobros de plataforma).
 *
 * Los tests unitarios del módulo usan un Prisma en memoria que IMITA la
 * unicidad y la visibilidad por tenant. Aquí se comprueba que la base real se
 * comporta así, conectando como el runtime: rol `didacta_app` (NOSUPERUSER,
 * NOBYPASSRLS), con las políticas y los triggers de `rls.sql` aplicados.
 *
 *  1. Aislamiento: el tenant A no ve filas de B en NINGUNA de las nueve tablas
 *     `mod_payouts_*`, y no puede escribir a nombre de B.
 *  2. El libro es de solo inserción: UPDATE y DELETE fallan, también para el
 *     dueño de la tabla y para `didacta_super`.
 *  3. Dos inserciones con la misma `idempotency_key` dejan una fila.
 *  4. El registro de objetos no se deja reasignar a otro tenant.
 *  5. Con el modo plataforma apagado, `PaymentModeResolver` devuelve lo mismo
 *     que `TenantStripeResolverService`.
 *
 * REQUISITOS: los de `rls-isolation-didacta-app.integration.test.ts` — un
 * Postgres en Docker con el schema aplicado (el globalSetup hace `db push`).
 * Contenedor y credenciales por las mismas variables `RLS_TEST_*`.
 *
 * SKIP: sin DATABASE_URL.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuditLogService } from '@didacta/core-kernel';
import { PrismaClient, withTenantContext } from '@didacta/database';
import {
  IDEMPOTENCY_KEYS,
  LedgerService,
  PayoutsLedgerIdempotencyConflictError,
  PayoutsObjectRefConflictError,
  RefsService,
  computeSplit,
} from '@didacta/mod-payouts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentModeResolver, type PaymentMode } from '../../src/modules/payment-mode.resolver';
import { loadPlatformPaymentsConfig } from '../../src/modules/payouts/platform-payments.config';
import { PrismaTenantConfigService } from '../../src/modules/prisma-tenant-config.service';
import { SecretCipherService } from '../../src/modules/secret-cipher.service';
import {
  TenantStripeResolverService,
  buildGlobalFallbackFlagReader,
  type GlobalFallbackPolicyStore,
  type ResolvedStripeCredentials,
} from '../../src/modules/tenant-stripe-resolver.service';

const ADMIN_DATABASE_URL = process.env['DATABASE_URL'];
const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

const PG_CONTAINER = process.env['RLS_TEST_PG_CONTAINER'] ?? 'didacta-postgres-test';
const PG_USER = process.env['RLS_TEST_PG_USER'] ?? 'didacta_test';
const PG_DB = process.env['RLS_TEST_PG_DB'] ?? 'didacta_test';
const APP_PASSWORD = process.env['RLS_TEST_APP_PASSWORD'] ?? 'rls_test_didacta_app_pw';

const REPO_ROOT = resolve(__dirname, '../../../..');

/** Igual que el entrypoint real: psql dentro del contenedor, con ON_ERROR_STOP. */
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

/** Las nueve tablas del módulo, por el nombre de su modelo en el cliente. */
const TABLAS = [
  'modPayoutsSettings',
  'modPayoutsAccount',
  'modPayoutsObjectRef',
  'modPayoutsSale',
  'modPayoutsLedgerEntry',
  'modPayoutsDebt',
  'modPayoutsRefund',
  'modPayoutsDispute',
  'modPayoutsWebhookEvent',
] as const;
type Tabla = (typeof TABLAS)[number];

type Tx = Parameters<Parameters<typeof withTenantContext>[2]>[0];

interface Semilla {
  tenantId: string;
  accountId: string;
  saleId: string;
  ledgerId: string;
  charge: string;
  ref: string;
  refund: string;
  dispute: string;
  event: string;
  ledgerKey: string;
}

describeWithDb('mod.payouts — cimientos contra Postgres como didacta_app', () => {
  let admin: PrismaClient;
  let appDb: PrismaClient;
  let A: Semilla;
  let B: Semilla;
  /** Evento «sin atribuir»: `tenant_id` nulo. */
  const eventoSinTenant = `evt_test_sin_tenant_${randomUUID().replace(/-/g, '')}`;
  const tenantsExtra: string[] = [];

  /** Corre `fn` como `didacta_app` con el GUC del tenant: lo que ve el runtime. */
  function comoTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantContext(appDb, tenantId, fn);
  }

  async function crearTenant(etiqueta: string): Promise<string> {
    const id = randomUUID();
    await admin.tenant.create({
      data: { id, slug: `payouts-${etiqueta}-${id.slice(0, 8)}`, name: `Payouts ${etiqueta}` },
    });
    return id;
  }

  /** Una fila en cada una de las nueve tablas, a nombre del tenant. */
  async function sembrar(etiqueta: string): Promise<Semilla> {
    const tenantId = await crearTenant(etiqueta);
    const u = randomUUID().replace(/-/g, '');
    const s: Semilla = {
      tenantId,
      accountId: randomUUID(),
      saleId: randomUUID(),
      ledgerId: randomUUID(),
      charge: `ch_test_${u}`,
      ref: `cs_test_${u}`,
      refund: `re_test_${u}`,
      dispute: `du_test_${u}`,
      event: `evt_test_${u}`,
      ledgerKey: IDEMPOTENCY_KEYS.transfer(`semilla-${u}`),
    };
    const split = computeSplit({ gross: 10000, stripeFee: 175, feeBps: 500 });

    await admin.modPayoutsSettings.create({ data: { tenantId, feeBps: 500 } });
    await admin.modPayoutsAccount.create({
      data: {
        id: s.accountId,
        tenantId,
        stripeAccountId: `acct_test_${u}`,
        country: 'ES',
        entityType: 'individual',
        status: 'READY',
        readyAt: new Date(),
      },
    });
    await admin.modPayoutsObjectRef.create({
      data: { stripeObjectId: s.ref, tenantId, kind: 'checkout_session', source: 'billing' },
    });
    await admin.modPayoutsSale.create({
      data: {
        id: s.saleId,
        tenantId,
        accountId: s.accountId,
        sourceKind: 'ORDER',
        sourceRef: randomUUID(),
        stripeChargeId: s.charge,
        presentmentAmount: 10000,
        presentmentCurrency: 'eur',
        gross: split.gross,
        stripeFee: split.stripeFee,
        feeBpsApplied: split.feeBpsApplied,
        platformFee: split.platformFee,
        creatorNet: split.creatorNet,
        transferAmount: split.creatorNet,
        currency: 'eur',
        status: 'TRANSFERRED',
      },
    });
    await admin.modPayoutsLedgerEntry.create({
      data: {
        id: s.ledgerId,
        tenantId,
        accountId: s.accountId,
        saleId: s.saleId,
        type: 'TRANSFER',
        amount: -split.creatorNet,
        currency: 'eur',
        idempotencyKey: s.ledgerKey,
        occurredAt: new Date(),
      },
    });
    await admin.modPayoutsDebt.create({
      data: {
        tenantId,
        accountId: s.accountId,
        reason: 'REFUND_FEE',
        originSaleId: s.saleId,
        amountOriginal: 175,
        amountOutstanding: 175,
        currency: 'eur',
      },
    });
    await admin.modPayoutsRefund.create({
      data: { tenantId, saleId: s.saleId, stripeRefundId: s.refund, amount: 4000, currency: 'eur' },
    });
    await admin.modPayoutsDispute.create({
      data: {
        tenantId,
        saleId: s.saleId,
        stripeDisputeId: s.dispute,
        status: 'needs_response',
        amount: 10000,
        currency: 'eur',
        fee: 2000,
      },
    });
    await admin.modPayoutsWebhookEvent.create({
      data: { stripeEventId: s.event, tenantId, type: 'charge.updated', objectId: s.charge },
    });
    return s;
  }

  /** `findMany` genérico sobre cualquiera de las nueve tablas. */
  function filasDe(db: Tx | PrismaClient, tabla: Tabla, tenantIds: string[]) {
    const delegate = db[tabla] as unknown as {
      findMany(args: {
        where: { tenantId: { in: string[] } };
      }): Promise<Array<{ tenantId: string }>>;
    };
    return delegate.findMany({ where: { tenantId: { in: tenantIds } } });
  }

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_DATABASE_URL } } });
    await admin.$connect();

    applySqlFileViaPsql('packages/database/prisma/rls.sql');
    applySqlFileViaPsql('packages/database/prisma/grants.sql');
    await admin.$executeRawUnsafe(
      `ALTER ROLE didacta_app PASSWORD '${APP_PASSWORD.replace(/'/g, "''")}'`,
    );

    appDb = new PrismaClient({
      datasources: { db: { url: buildDidactaAppUrl(ADMIN_DATABASE_URL!) } },
    });
    await appDb.$connect();

    A = await sembrar('a');
    B = await sembrar('b');
    await admin.modPayoutsWebhookEvent.create({
      data: { stripeEventId: eventoSinTenant, tenantId: null, type: 'charge.updated' },
    });
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    const tenantIds = [A?.tenantId, B?.tenantId, ...tenantsExtra].filter(
      (id): id is string => typeof id === 'string',
    );
    const where = { tenantId: { in: tenantIds } };
    // El libro no admite DELETE: la única forma de limpiar es que un superuser
    // desactive los triggers a propósito, dentro de su transacción.
    await admin.$transaction([
      admin.$executeRawUnsafe('SET LOCAL session_replication_role = replica'),
      admin.modPayoutsLedgerEntry.deleteMany({ where }),
      admin.modPayoutsDebt.deleteMany({ where }),
      admin.modPayoutsRefund.deleteMany({ where }),
      admin.modPayoutsDispute.deleteMany({ where }),
      admin.modPayoutsSale.deleteMany({ where }),
      admin.modPayoutsAccount.deleteMany({ where }),
      admin.modPayoutsObjectRef.deleteMany({ where }),
      admin.modPayoutsSettings.deleteMany({ where }),
      admin.modPayoutsWebhookEvent.deleteMany({
        where: { OR: [where, { stripeEventId: eventoSinTenant }] },
      }),
      admin.tenantSetting.deleteMany({ where }),
    ]);
    await admin.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await appDb?.$disconnect();
    await admin.$disconnect();
  }, 60_000);

  // ── Precondiciones: sin ellas, lo de abajo no probaría nada ────────────────

  describe('precondiciones', () => {
    it('la conexión de la app es NOSUPERUSER y NOBYPASSRLS', async () => {
      const rows = await appDb.$queryRaw<
        Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>
      >`SELECT current_user::text, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(rows).toEqual([{ current_user: 'didacta_app', rolsuper: false, rolbypassrls: false }]);
    });

    it('las tablas con tenant_id tienen RLS activada, FORZADA y la política tenant_isolation', async () => {
      const rows = await admin.$queryRaw<
        Array<{
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
          policies: string[];
        }>
      >`
        SELECT c.relname::text,
               c.relrowsecurity,
               c.relforcerowsecurity,
               ARRAY(SELECT p.polname::text FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'mod\\_payouts\\_%'
          -- El contador de facturas es GLOBAL a propósito (la numeración es del
          -- emisor): no tiene tenant_id. Se comprueba aparte, abajo.
          AND c.relname <> 'mod_payouts_invoice_counter'
        ORDER BY c.relname`;
      expect(rows.map((r) => r.relname)).toEqual([
        'mod_payouts_account',
        'mod_payouts_debt',
        'mod_payouts_dispute',
        'mod_payouts_invoice',
        'mod_payouts_invoice_item',
        'mod_payouts_ledger_entry',
        'mod_payouts_object_ref',
        'mod_payouts_refund',
        'mod_payouts_sale',
        'mod_payouts_settings',
        'mod_payouts_tax_profile',
        'mod_payouts_webhook_event',
      ]);
      for (const row of rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.relforcerowsecurity, row.relname).toBe(true);
        expect(row.policies, row.relname).toEqual(['tenant_isolation']);
      }
    });

    it('el contador de facturas es la única tabla del módulo sin tenant_id', async () => {
      const rows = await admin.$queryRaw<Array<{ table_name: string }>>`
        SELECT t.table_name::text
        FROM information_schema.tables t
        WHERE t.table_schema = 'public' AND t.table_name LIKE 'mod\\_payouts\\_%'
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = t.table_name
              AND c.column_name = 'tenant_id'
          )`;
      expect(rows.map((r) => r.table_name)).toEqual(['mod_payouts_invoice_counter']);
    });

    it('el libro tiene los dos triggers de solo inserción, activos', async () => {
      const rows = await admin.$queryRaw<Array<{ tgname: string; tgenabled: string }>>`
        SELECT tgname::text, tgenabled::text
        FROM pg_trigger
        WHERE tgrelid = 'mod_payouts_ledger_entry'::regclass AND NOT tgisinternal
        ORDER BY tgname`;
      expect(rows).toEqual([
        { tgname: 'mod_payouts_ledger_no_delete', tgenabled: 'O' },
        { tgname: 'mod_payouts_ledger_no_update', tgenabled: 'O' },
      ]);
    });

    it('control: la semilla existe — el admin ve una fila de A y otra de B en cada tabla', async () => {
      for (const tabla of TABLAS) {
        const filas = await filasDe(admin, tabla, [A.tenantId, B.tenantId]);
        expect(filas.map((f) => f.tenantId).sort(), tabla).toEqual([A.tenantId, B.tenantId].sort());
      }
    });
  });

  // ── 1. Aislamiento entre tenants ──────────────────────────────────────────

  describe('aislamiento: A no ve filas de B', () => {
    it.each(TABLAS)('%s: en el contexto de A solo sale la fila de A', async (tabla) => {
      const vistas = await comoTenant(A.tenantId, (tx) =>
        filasDe(tx, tabla, [A.tenantId, B.tenantId]),
      );
      expect(vistas.map((f) => f.tenantId)).toEqual([A.tenantId]);
    });

    it.each(TABLAS)('%s: en el contexto de B solo sale la fila de B', async (tabla) => {
      const vistas = await comoTenant(B.tenantId, (tx) =>
        filasDe(tx, tabla, [A.tenantId, B.tenantId]),
      );
      expect(vistas.map((f) => f.tenantId)).toEqual([B.tenantId]);
    });

    it.each(TABLAS)('%s: sin contexto de tenant no sale NINGUNA fila', async (tabla) => {
      expect(await filasDe(appDb, tabla, [A.tenantId, B.tenantId])).toEqual([]);
    });

    it('buscar por la clave única de B desde A no encuentra nada', async () => {
      const encontrado = await comoTenant(A.tenantId, async (tx) => ({
        venta: await tx.modPayoutsSale.findUnique({ where: { stripeChargeId: B.charge } }),
        asiento: await tx.modPayoutsLedgerEntry.findUnique({
          where: { idempotencyKey: B.ledgerKey },
        }),
        ref: await tx.modPayoutsObjectRef.findUnique({ where: { stripeObjectId: B.ref } }),
        reembolso: await tx.modPayoutsRefund.findUnique({ where: { stripeRefundId: B.refund } }),
        disputa: await tx.modPayoutsDispute.findUnique({ where: { stripeDisputeId: B.dispute } }),
        evento: await tx.modPayoutsWebhookEvent.findUnique({ where: { stripeEventId: B.event } }),
        ajustes: await tx.modPayoutsSettings.findUnique({ where: { tenantId: B.tenantId } }),
        cuenta: await tx.modPayoutsAccount.findUnique({ where: { id: B.accountId } }),
      }));
      expect(encontrado).toEqual({
        venta: null,
        asiento: null,
        ref: null,
        reembolso: null,
        disputa: null,
        evento: null,
        ajustes: null,
        cuenta: null,
      });
    });

    it('A no puede INSERTAR a nombre de B (WITH CHECK)', async () => {
      await expect(
        comoTenant(A.tenantId, (tx) =>
          tx.modPayoutsObjectRef.create({
            data: {
              stripeObjectId: `pi_test_${randomUUID().replace(/-/g, '')}`,
              tenantId: B.tenantId,
              kind: 'payment_intent',
              source: 'billing',
            },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        comoTenant(A.tenantId, (tx) =>
          tx.modPayoutsSettings.create({ data: { tenantId: randomUUID(), feeBps: 0 } }),
        ),
      ).rejects.toThrow();
    });

    it('A no puede CAMBIAR la comisión ni la venta de B: el UPDATE no toca ninguna fila', async () => {
      const tocadas = await comoTenant(A.tenantId, async (tx) => ({
        ajustes: await tx.modPayoutsSettings.updateMany({
          where: { tenantId: B.tenantId },
          data: { feeBps: 0 },
        }),
        ventas: await tx.modPayoutsSale.updateMany({
          where: { id: B.saleId },
          data: { status: 'FAILED' },
        }),
        cuentas: await tx.modPayoutsAccount.deleteMany({ where: { id: B.accountId } }),
      }));
      expect(tocadas).toEqual({
        ajustes: { count: 0 },
        ventas: { count: 0 },
        cuentas: { count: 0 },
      });

      const [ajustes, venta] = await Promise.all([
        admin.modPayoutsSettings.findUniqueOrThrow({ where: { tenantId: B.tenantId } }),
        admin.modPayoutsSale.findUniqueOrThrow({ where: { id: B.saleId } }),
      ]);
      expect(ajustes.feeBps).toBe(500);
      expect(venta.status).toBe('TRANSFERRED');
    });

    it('un evento sin tenant no lo ve ningún tenant; el acceso global sancionado sí', async () => {
      const desdeA = await comoTenant(A.tenantId, (tx) =>
        tx.modPayoutsWebhookEvent.findUnique({ where: { stripeEventId: eventoSinTenant } }),
      );
      expect(desdeA).toBeNull();

      const [, sancionado] = await appDb.$transaction([
        appDb.$executeRaw`SET LOCAL ROLE didacta_super`,
        appDb.modPayoutsWebhookEvent.findMany({
          where: { stripeEventId: { in: [eventoSinTenant, A.event, B.event] } },
          select: { stripeEventId: true },
        }),
      ]);
      expect(
        (sancionado as Array<{ stripeEventId: string }>).map((e) => e.stripeEventId).sort(),
      ).toEqual([eventoSinTenant, A.event, B.event].sort());
    });
  });

  // ── 2. Libro de solo inserción ────────────────────────────────────────────

  describe('el libro es de solo inserción', () => {
    it('control: el dueño del asiento SÍ lo ve (si no, el UPDATE no llegaría al trigger)', async () => {
      const visto = await comoTenant(A.tenantId, (tx) =>
        tx.modPayoutsLedgerEntry.findUnique({ where: { id: A.ledgerId } }),
      );
      expect(visto?.amount).toBe(-9325);
    });

    it('UPDATE falla para el propio tenant (didacta_app)', async () => {
      await expect(
        comoTenant(A.tenantId, (tx) =>
          tx.modPayoutsLedgerEntry.update({ where: { id: A.ledgerId }, data: { amount: -1 } }),
        ),
      ).rejects.toThrow(/solo inserci/);
      await expect(
        comoTenant(A.tenantId, (tx) =>
          tx.modPayoutsLedgerEntry.updateMany({
            where: { tenantId: A.tenantId },
            data: { metadata: { manipulado: true } },
          }),
        ),
      ).rejects.toThrow(/solo inserci/);
    });

    it('DELETE falla para el propio tenant (didacta_app)', async () => {
      await expect(
        comoTenant(A.tenantId, (tx) =>
          tx.modPayoutsLedgerEntry.delete({ where: { id: A.ledgerId } }),
        ),
      ).rejects.toThrow(/solo inserci/);
      await expect(
        comoTenant(A.tenantId, (tx) =>
          tx.modPayoutsLedgerEntry.deleteMany({ where: { tenantId: A.tenantId } }),
        ),
      ).rejects.toThrow(/solo inserci/);
    });

    it('UPDATE y DELETE fallan también con el acceso global sancionado (didacta_super)', async () => {
      await expect(
        appDb.$transaction([
          appDb.$executeRaw`SET LOCAL ROLE didacta_super`,
          appDb.modPayoutsLedgerEntry.update({ where: { id: A.ledgerId }, data: { amount: -1 } }),
        ]),
      ).rejects.toThrow(/solo inserci/);
      await expect(
        appDb.$transaction([
          appDb.$executeRaw`SET LOCAL ROLE didacta_super`,
          appDb.modPayoutsLedgerEntry.delete({ where: { id: A.ledgerId } }),
        ]),
      ).rejects.toThrow(/solo inserci/);
    });

    it('UPDATE y DELETE fallan también para el dueño de la tabla (conexión admin)', async () => {
      await expect(
        admin.modPayoutsLedgerEntry.update({ where: { id: A.ledgerId }, data: { amount: -1 } }),
      ).rejects.toThrow(/solo inserci/);
      await expect(
        admin.modPayoutsLedgerEntry.delete({ where: { id: A.ledgerId } }),
      ).rejects.toThrow(/solo inserci/);
      await expect(
        admin.$executeRaw`UPDATE mod_payouts_ledger_entry SET amount = 0 WHERE id = ${A.ledgerId}::uuid`,
      ).rejects.toThrow(/solo inserci/);
      await expect(
        admin.$executeRaw`DELETE FROM mod_payouts_ledger_entry WHERE id = ${A.ledgerId}::uuid`,
      ).rejects.toThrow(/solo inserci/);
    });

    it('una venta con asientos no se puede borrar (FK Restrict)', async () => {
      await expect(admin.modPayoutsSale.delete({ where: { id: A.saleId } })).rejects.toThrow();
    });

    it('después de todos los intentos, el asiento sigue intacto', async () => {
      const asiento = await admin.modPayoutsLedgerEntry.findUniqueOrThrow({
        where: { id: A.ledgerId },
      });
      expect(asiento).toMatchObject({ amount: -9325, type: 'TRANSFER', metadata: {} });
    });

    it('control: INSERT sí funciona (el trigger no bloquea de más)', async () => {
      const { created } = await comoTenant(A.tenantId, (tx) =>
        new LedgerService(tx as PrismaClient).append({
          tenantId: A.tenantId,
          accountId: A.accountId,
          saleId: A.saleId,
          type: 'ADJUSTMENT',
          amount: 1,
          currency: 'eur',
          idempotencyKey: `test:insert-ok:${A.saleId}`,
          occurredAt: new Date(),
        }),
      );
      expect(created).toBe(true);
    });
  });

  // ── 3. Idempotencia del libro ─────────────────────────────────────────────

  describe('idempotency_key', () => {
    function asiento(clave: string, overrides: { tenant?: Semilla; amount?: number } = {}) {
      const dueno = overrides.tenant ?? A;
      return {
        tenantId: dueno.tenantId,
        accountId: dueno.accountId,
        saleId: dueno.saleId,
        type: 'REFUND' as const,
        amount: overrides.amount ?? -4000,
        currency: 'eur',
        stripeObjectId: 're_test_idem',
        idempotencyKey: clave,
        occurredAt: new Date(),
      };
    }

    it('dos inserciones con la misma clave dejan UNA sola fila', async () => {
      const clave = IDEMPOTENCY_KEYS.refund(randomUUID());

      const primera = await comoTenant(A.tenantId, (tx) =>
        new LedgerService(tx as PrismaClient).append(asiento(clave)),
      );
      const segunda = await comoTenant(A.tenantId, (tx) =>
        new LedgerService(tx as PrismaClient).append(asiento(clave)),
      );

      expect(primera.created).toBe(true);
      expect(segunda.created).toBe(false);
      expect(segunda.entry.id).toBe(primera.entry.id);
      expect(await admin.modPayoutsLedgerEntry.count({ where: { idempotencyKey: clave } })).toBe(1);
    });

    it('cinco inserciones en paralelo (cinco conexiones) dejan UNA sola fila', async () => {
      const clave = IDEMPOTENCY_KEYS.refund(randomUUID());

      const resultados = await Promise.all(
        Array.from({ length: 5 }, () =>
          comoTenant(A.tenantId, (tx) =>
            new LedgerService(tx as PrismaClient).append(asiento(clave)),
          ),
        ),
      );

      expect(resultados.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(resultados.map((r) => r.entry.id)).size).toBe(1);
      expect(await admin.modPayoutsLedgerEntry.count({ where: { idempotencyKey: clave } })).toBe(1);
    });

    it('el duplicado NO aborta la transacción del que llama', async () => {
      const clave = IDEMPOTENCY_KEYS.refund(randomUUID());
      const otra = IDEMPOTENCY_KEYS.refund(randomUUID());

      // Todo en UNA transacción: asiento, su duplicado y trabajo posterior. Con
      // un INSERT que fallara por unicidad, Postgres dejaría la transacción
      // abortada y lo de después reventaría («current transaction is aborted»).
      const resultado = await comoTenant(A.tenantId, async (tx) => {
        const ledger = new LedgerService(tx as PrismaClient);
        const a = await ledger.append(asiento(clave));
        const b = await ledger.append(asiento(clave));
        const c = await ledger.append(asiento(otra, { amount: -1 }));
        const ventas = await tx.modPayoutsSale.count({ where: { tenantId: A.tenantId } });
        return { a: a.created, b: b.created, c: c.created, ventas };
      });

      expect(resultado).toEqual({ a: true, b: false, c: true, ventas: 1 });
      expect(
        await admin.modPayoutsLedgerEntry.count({
          where: { idempotencyKey: { in: [clave, otra] } },
        }),
      ).toBe(2);
    });

    it('control: la unicidad está en la base — un INSERT a pelo con la clave repetida falla', async () => {
      const clave = IDEMPOTENCY_KEYS.refund(randomUUID());
      const datos = asiento(clave);
      await admin.modPayoutsLedgerEntry.create({ data: datos });
      await expect(admin.modPayoutsLedgerEntry.create({ data: datos })).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('la misma clave con otro importe lanza y no escribe', async () => {
      const clave = IDEMPOTENCY_KEYS.refund(randomUUID());
      await comoTenant(A.tenantId, (tx) =>
        new LedgerService(tx as PrismaClient).append(asiento(clave)),
      );

      await expect(
        comoTenant(A.tenantId, (tx) =>
          new LedgerService(tx as PrismaClient).append(asiento(clave, { amount: -3999 })),
        ),
      ).rejects.toBeInstanceOf(PayoutsLedgerIdempotencyConflictError);

      const filas = await admin.modPayoutsLedgerEntry.findMany({
        where: { idempotencyKey: clave },
      });
      expect(filas.map((f) => f.amount)).toEqual([-4000]);
    });

    it('B no puede reutilizar una clave de A: conflicto, y la fila de A no se toca', async () => {
      const clave = IDEMPOTENCY_KEYS.refund(randomUUID());
      await comoTenant(A.tenantId, (tx) =>
        new LedgerService(tx as PrismaClient).append(asiento(clave)),
      );

      await expect(
        comoTenant(B.tenantId, (tx) =>
          new LedgerService(tx as PrismaClient).append(asiento(clave, { tenant: B })),
        ),
      ).rejects.toBeInstanceOf(PayoutsLedgerIdempotencyConflictError);

      const filas = await admin.modPayoutsLedgerEntry.findMany({
        where: { idempotencyKey: clave },
      });
      expect(filas.map((f) => f.tenantId)).toEqual([A.tenantId]);
    });

    it('el saldo se suma en bigint: tres asientos de 2 000 000 000 dan 6 000 000 000', async () => {
      // Cuenta aparte para que el saldo no dependa del resto de tests.
      const tenantId = await crearTenant('suma');
      tenantsExtra.push(tenantId);
      const accountId = randomUUID();
      await admin.modPayoutsAccount.create({
        data: { id: accountId, tenantId, country: 'ES', entityType: 'company' },
      });

      const saldo = await comoTenant(tenantId, async (tx) => {
        const ledger = new LedgerService(tx as PrismaClient);
        for (let i = 0; i < 3; i += 1) {
          await ledger.append({
            tenantId,
            accountId,
            type: 'ADJUSTMENT',
            amount: 2_000_000_000,
            currency: 'eur',
            idempotencyKey: `test:suma:${accountId}:${i}`,
            occurredAt: new Date(),
          });
        }
        await ledger.append({
          tenantId,
          accountId,
          type: 'ADJUSTMENT',
          amount: -5,
          currency: 'usd',
          idempotencyKey: `test:suma:${accountId}:usd`,
          occurredAt: new Date(),
        });
        return ledger.balanceByAccount(tenantId, accountId);
      });

      expect(saldo).toEqual([
        { currency: 'eur', total: 6_000_000_000n, entries: 3 },
        { currency: 'usd', total: -5n, entries: 1 },
      ]);
      // Y otro tenant, preguntando por esa misma cuenta, no ve nada.
      expect(
        await comoTenant(A.tenantId, (tx) =>
          new LedgerService(tx as PrismaClient).balanceByAccount(tenantId, accountId),
        ),
      ).toEqual([]);
    });
  });

  // ── 4. Registro objeto de Stripe → tenant ─────────────────────────────────

  describe('registro de objetos', () => {
    it('B no puede quedarse un objeto de A, aunque RLS no le deje verlo', async () => {
      const id = `pi_test_${randomUUID().replace(/-/g, '')}`;
      const entrada = {
        stripeObjectId: id,
        kind: 'payment_intent',
        source: 'billing',
        livemode: false,
      } as const;

      const alta = await comoTenant(A.tenantId, (tx) =>
        new RefsService(tx as PrismaClient).register({ ...entrada, tenantId: A.tenantId }),
      );
      const reintento = await comoTenant(A.tenantId, (tx) =>
        new RefsService(tx as PrismaClient).register({ ...entrada, tenantId: A.tenantId }),
      );
      expect([alta.created, reintento.created]).toEqual([true, false]);

      await expect(
        comoTenant(B.tenantId, (tx) =>
          new RefsService(tx as PrismaClient).register({ ...entrada, tenantId: B.tenantId }),
        ),
      ).rejects.toBeInstanceOf(PayoutsObjectRefConflictError);

      const fila = await admin.modPayoutsObjectRef.findUniqueOrThrow({
        where: { stripeObjectId: id },
      });
      expect(fila.tenantId).toBe(A.tenantId);
    });

    it('resolveTenant: con acceso global sancionado resuelve; dentro de otro tenant, no', async () => {
      // Como lo hará el webhook de plataforma: SET LOCAL ROLE didacta_super.
      const global = await appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE didacta_super`;
        const refs = new RefsService(tx as PrismaClient);
        return {
          deA: await refs.resolveTenant(['ch_test_sin_registrar', A.ref]),
          ambiguo: await refs.resolveTenant([A.ref, B.ref]),
          nadie: await refs.resolveTenant(['cs_test_de_otra_cuenta']),
          esDePlataforma: await refs.isPlatformObject([B.ref]),
        };
      });
      expect(global.deA).toMatchObject({ status: 'resolved', tenantId: A.tenantId });
      expect(global.ambiguo).toMatchObject({
        status: 'ambiguous',
        tenantIds: [A.tenantId, B.tenantId].sort(),
      });
      expect(global.nadie).toEqual({ status: 'unknown' });
      expect(global.esDePlataforma).toBe(true);

      const desdeB = await comoTenant(B.tenantId, (tx) =>
        new RefsService(tx as PrismaClient).resolveTenant([A.ref]),
      );
      expect(desdeB).toEqual({ status: 'unknown' });
    });
  });

  // ── 5. Resolver de modo de cobro ──────────────────────────────────────────

  describe('PaymentModeResolver', () => {
    const CLAVES = {
      secretKey: 'sk_test_delCreador0000',
      webhookSecret: 'whsec_test_delCreador_0001',
    };
    const VARIABLES = [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'SUBSCRIPTIONS_WEBHOOK_SECRET',
      'STRIPE_ALLOW_GLOBAL_FALLBACK',
    ] as const;

    let tenantConfig: PrismaTenantConfigService;
    let conClaves: string;
    let sinVerificar: string;
    let sinClaves: string;

    /** Resolutor de claves REAL contra la base, con el candado de producción. */
    function resolutorDeClaves(): TenantStripeResolverService {
      return new TenantStripeResolverService(
        tenantConfig,
        buildGlobalFallbackFlagReader(admin as unknown as GlobalFallbackPolicyStore),
      );
    }

    /** Corre `fn` con unas `STRIPE_*` de instancia concretas y las restaura. */
    async function conEntorno<T>(
      valores: Partial<Record<(typeof VARIABLES)[number], string>>,
      fn: () => Promise<T>,
    ): Promise<T> {
      const previas = VARIABLES.map((v) => [v, process.env[v]] as const);
      for (const v of VARIABLES) delete process.env[v];
      Object.assign(process.env, valores);
      try {
        return await fn();
      } finally {
        for (const [v, valor] of previas) {
          if (valor === undefined) delete process.env[v];
          else process.env[v] = valor;
        }
      }
    }

    function esperado(resuelto: ResolvedStripeCredentials | null): PaymentMode {
      return resuelto ? { mode: 'own', credentials: resuelto } : { mode: 'none' };
    }

    beforeAll(async () => {
      const auditoria = { record: async () => undefined } as unknown as AuditLogService;
      tenantConfig = new PrismaTenantConfigService(
        admin as never,
        new SecretCipherService('ab'.repeat(32)),
        auditoria,
      );
      conClaves = await crearTenant('claves');
      sinVerificar = await crearTenant('sinverificar');
      sinClaves = await crearTenant('sinclaves');
      tenantsExtra.push(conClaves, sinVerificar, sinClaves);
      await tenantConfig.set(conClaves, 'billing', 'stripe', CLAVES, { isSecret: true });
      await tenantConfig.set(conClaves, 'billing', 'stripe_meta', {
        verifiedAt: new Date().toISOString(),
      });
      await tenantConfig.set(sinVerificar, 'billing', 'stripe', CLAVES, { isSecret: true });
    });

    describe('sin variables PAYMENTS_PLATFORM_*: lo mismo que TenantStripeResolverService', () => {
      const apagado = loadPlatformPaymentsConfig({});
      const sinBase = () => {
        throw new Error('con el modo apagado el resolver no debe leer la base');
      };

      it('la configuración sin variables es «modo apagado»', () => {
        expect(apagado).toEqual({ enabled: false });
      });

      it('tenant con claves propias verificadas → own / tenant', async () => {
        await conEntorno({}, async () => {
          const directo = await resolutorDeClaves().resolve(conClaves);
          const modo = await new PaymentModeResolver(apagado, resolutorDeClaves(), sinBase).resolve(
            conClaves,
          );
          // Control: el resolutor real ha leído y descifrado las claves de la base.
          expect(directo).toEqual({ credentials: CLAVES, source: 'tenant', verified: true });
          expect(modo).toEqual(esperado(directo));
        });
      });

      it('tenant con claves propias sin verificar → own / tenant_unverified', async () => {
        await conEntorno({}, async () => {
          const directo = await resolutorDeClaves().resolve(sinVerificar);
          const modo = await new PaymentModeResolver(apagado, resolutorDeClaves(), sinBase).resolve(
            sinVerificar,
          );
          expect(directo?.source).toBe('tenant_unverified');
          expect(modo).toEqual(esperado(directo));
        });
      });

      it('tenant sin claves y sin claves de instancia → none', async () => {
        await conEntorno({}, async () => {
          const directo = await resolutorDeClaves().resolve(sinClaves);
          const modo = await new PaymentModeResolver(apagado, resolutorDeClaves(), sinBase).resolve(
            sinClaves,
          );
          expect(directo).toBeNull();
          expect(modo).toEqual({ mode: 'none' });
        });
      });

      it('tenant sin claves, con claves de instancia y fallback permitido → own / global', async () => {
        await conEntorno(
          {
            STRIPE_SECRET_KEY: 'sk_test_deInstancia0000',
            STRIPE_WEBHOOK_SECRET: 'whsec_test_deInstancia_0001',
            STRIPE_ALLOW_GLOBAL_FALLBACK: 'true',
          },
          async () => {
            const directo = await resolutorDeClaves().resolve(sinClaves);
            const modo = await new PaymentModeResolver(
              apagado,
              resolutorDeClaves(),
              sinBase,
            ).resolve(sinClaves);
            expect(directo?.source).toBe('global');
            expect(modo).toEqual(esperado(directo));
          },
        );
      });

      it('tenant sin claves, con claves de instancia y fallback cerrado (varias aulas) → none', async () => {
        await conEntorno(
          {
            STRIPE_SECRET_KEY: 'sk_test_deInstancia0000',
            STRIPE_WEBHOOK_SECRET: 'whsec_test_deInstancia_0001',
          },
          async () => {
            // Hay más de un aula en la base y nadie ha decidido: el candado
            // cierra el fallback. El resolver hereda esa decisión tal cual.
            expect(await admin.tenant.count()).toBeGreaterThan(1);
            const directo = await resolutorDeClaves().resolve(sinClaves);
            const modo = await new PaymentModeResolver(
              apagado,
              resolutorDeClaves(),
              sinBase,
            ).resolve(sinClaves);
            expect(directo).toBeNull();
            expect(modo).toEqual({ mode: 'none' });
          },
        );
      });

      it('aunque el tenant tenga una cuenta conectada lista en la base, no se mira', async () => {
        // A tiene `mod_payouts_account` en READY (semilla) y ninguna clave.
        await conEntorno({}, async () => {
          const modo = await new PaymentModeResolver(apagado, resolutorDeClaves(), sinBase).resolve(
            A.tenantId,
          );
          expect(modo).toEqual({ mode: 'none' });
        });
      });
    });

    describe('con el modo plataforma encendido, contra las tablas reales', () => {
      const encendido = loadPlatformPaymentsConfig({
        PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_dePlataforma0000',
        PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: 'whsec_test_plataforma_0001',
      });

      function resolver(tx: Tx): PaymentModeResolver {
        return new PaymentModeResolver(encendido, resolutorDeClaves(), () => tx);
      }

      it('cuenta lista → platform ready con la comisión del tenant', async () => {
        const cuenta = await admin.modPayoutsAccount.findUniqueOrThrow({
          where: { id: A.accountId },
        });
        await admin.modPayoutsSettings.update({
          where: { tenantId: A.tenantId },
          data: { feeBps: 300 },
        });
        try {
          const modo = await conEntorno({}, () =>
            comoTenant(A.tenantId, (tx) => resolver(tx).resolve(A.tenantId)),
          );
          expect(modo).toEqual({
            mode: 'platform',
            ready: true,
            stripeAccountId: cuenta.stripeAccountId,
            country: 'ES',
            feeBps: 300,
          });
        } finally {
          await admin.modPayoutsSettings.update({
            where: { tenantId: A.tenantId },
            data: { feeBps: 500 },
          });
        }
      });

      it('desde el contexto de B, la cuenta de A no existe: preguntar por A da not_connected', async () => {
        const modo = await conEntorno({}, () =>
          comoTenant(B.tenantId, (tx) => resolver(tx).resolve(A.tenantId)),
        );
        expect(modo).toEqual({ mode: 'platform', ready: false, reason: 'not_connected' });
      });

      it('tenant sin cuenta y con claves propias → own; sin claves → not_connected', async () => {
        const [propias, nada] = await conEntorno({}, async () => [
          await comoTenant(conClaves, (tx) => resolver(tx).resolve(conClaves)),
          await comoTenant(sinClaves, (tx) => resolver(tx).resolve(sinClaves)),
        ]);
        expect(propias).toEqual({
          mode: 'own',
          credentials: { credentials: CLAVES, source: 'tenant', verified: true },
        });
        expect(nada).toEqual({ mode: 'platform', ready: false, reason: 'not_connected' });
      });

      it('las claves de instancia NO hacen de respaldo con el modo encendido', async () => {
        const modo = await conEntorno(
          {
            STRIPE_SECRET_KEY: 'sk_test_deInstancia0000',
            STRIPE_WEBHOOK_SECRET: 'whsec_test_deInstancia_0001',
            STRIPE_ALLOW_GLOBAL_FALLBACK: 'true',
          },
          () => comoTenant(sinClaves, (tx) => resolver(tx).resolve(sinClaves)),
        );
        expect(modo).toEqual({ mode: 'platform', ready: false, reason: 'not_connected' });
      });

      it('la cuenta cerrada no cuenta; manda la más reciente sin cerrar', async () => {
        const tenantId = await crearTenant('cuentas');
        tenantsExtra.push(tenantId);
        const u = randomUUID().replace(/-/g, '');
        await admin.modPayoutsAccount.create({
          data: {
            tenantId,
            stripeAccountId: `acct_test_vieja_${u}`,
            country: 'ES',
            entityType: 'individual',
            status: 'READY',
            readyAt: new Date('2026-01-01T00:00:00Z'),
            closedAt: new Date('2026-06-01T00:00:00Z'),
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        });
        await admin.modPayoutsAccount.create({
          data: {
            tenantId,
            stripeAccountId: `acct_test_nueva_${u}`,
            country: 'FR',
            entityType: 'company',
            status: 'RESTRICTED',
            readyAt: new Date('2026-07-01T00:00:00Z'),
            createdAt: new Date('2026-07-01T00:00:00Z'),
          },
        });

        const modo = await conEntorno({}, () =>
          comoTenant(tenantId, (tx) => resolver(tx).resolve(tenantId)),
        );
        expect(modo).toEqual({ mode: 'platform', ready: false, reason: 'restricted' });
      });
    });
  });
});
