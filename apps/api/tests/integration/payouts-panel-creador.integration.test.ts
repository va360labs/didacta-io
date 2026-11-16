/**
 * Panel del creador y afiliados de Didacta Cloud (ADR-007 y ADR-008) contra un
 * Postgres REAL, conectando como el runtime de producción: rol `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS) y RLS forzada.
 *
 * Lo que solo se ve con la base de verdad:
 *  - `payouts/fees` lee el libro de TODAS las aulas con el acceso global
 *    sancionado y devuelve comisión cobrada y devuelta por separado;
 *  - `:id/payouts/summary|invoices|invoices/:id/pdf` solo ven el aula de la
 *    URL: la de otra aula no sale ni por la lista ni por el PDF (404);
 *  - el crédito de plataforma: una clave de idempotencia = UNA transferencia
 *    aunque lleguen cinco peticiones a la vez, el libro de solo inserción
 *    guarda los dos asientos que suman 0, el conciliador no ve ninguna
 *    violación, y ninguna otra aula ve esos asientos;
 *  - la marca (`:id/branding`): el nombre pasa por `rename` con su audit log y
 *    el color por el servicio de theming de verdad, bajo el contexto del aula.
 *
 * De verdad: `PayoutsRuntime` (con su cifrador y el emisor de facturas), el
 * controller, `AdminTenantsService`, `PrismaAuditLogService`, `ThemingService`
 * y la extensión RLS de Prisma. Simulado: Stripe (el doble en memoria).
 *
 * REQUISITOS: los de `rls-isolation-didacta-app.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import {
  InMemoryPlatformStripeClient,
  PayoutsReconcilerService,
  type StripeObject,
  type ViesClient,
  type ViesResult,
} from '@didacta/mod-payouts';
import { ThemingService } from '@didacta/mod-theming';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AdminTenantsPayoutsController } from '../../src/admin/admin-tenants.controller';
import { AdminTenantsController } from '../../src/admin/admin-tenants.controller';
import { AdminTenantsService } from '../../src/admin/admin-tenants.service';
import { brandToHex } from '../../src/admin/tenant-branding';
import { PrismaAuditLogService } from '../../src/modules/prisma-audit-log.service';
import { PayoutsRuntime } from '../../src/modules/payouts/payouts-runtime.service';
import {
  loadPlatformPaymentsConfig,
  type PlatformPaymentsEnabled,
} from '../../src/modules/payouts/platform-payments.config';
import { SecretCipherService } from '../../src/modules/secret-cipher.service';
import { TenantStripeResolverService } from '../../src/modules/tenant-stripe-resolver.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

const SERIES = Array.from({ length: 4 }, () =>
  String.fromCharCode(65 + Math.floor(Math.random() * 26)),
).join('');

const CONFIG = loadPlatformPaymentsConfig({
  PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_inventadaPanelCreador',
  PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: 'whsec_operador_panel_creador',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_NAME: 'VA360 LABS, S.L.',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_TAX_ID: 'B24805335',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_VAT_ID: 'ESB24805335',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_ADDRESS_LINE1: 'C/ Juan José Sánchez Rodríguez, 24',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_POSTAL_CODE: '11630',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_CITY: 'Arcos de la Frontera',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_REGION: 'Cádiz',
  PAYMENTS_PLATFORM_INVOICE_SERIES: SERIES,
}) as PlatformPaymentsEnabled;

const silentVies: ViesClient = {
  check: async (): Promise<ViesResult> => ({
    status: 'unavailable',
    checkedAt: new Date(),
    detail: 'MS_UNAVAILABLE',
  }),
};

const machineReq = {
  provisioningActor: { credentialId: randomUUID() },
  headers: {},
  ip: '127.0.0.1',
};

describeWithDb('Panel del creador — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let runtime: PayoutsRuntime;
  let payoutsController: AdminTenantsPayoutsController;
  let tenantsController: AdminTenantsController;
  let reconciler: PayoutsReconcilerService;

  const stamp = Date.now();
  const A = randomUUID();
  const B = randomUUID();
  // C y D solo hacen créditos: sus libros no llevan datos de ventas inventados,
  // así que el conciliador puede dar su veredicto limpio sobre ellos.
  const C = randomUUID();
  const D = randomUUID();
  const ACCT: Record<string, string> = {
    [A]: `acct_1PcA${stamp}`,
    [B]: `acct_1PcB${stamp}`,
    [C]: `acct_1PcC${stamp}`,
    [D]: `acct_1PcD${stamp}`,
  };
  const ACCOUNT_ID: Record<string, string> = {
    [A]: randomUUID(),
    [B]: randomUUID(),
    [C]: randomUUID(),
    [D]: randomUUID(),
  };
  const fake = new InMemoryPlatformStripeClient({ livemode: false });
  const transfers: StripeObject[] = [];
  const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
  const cipher = new SecretCipherService(process.env['TENANT_SETTINGS_ENC_KEY'] ?? '0'.repeat(64));

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    const previous = { url: process.env['DATABASE_URL'], mode: process.env['RLS_ENFORCEMENT'] };
    process.env['DATABASE_URL'] = prepared.appUrl;
    process.env['RLS_ENFORCEMENT'] = 'on';
    try {
      const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      closeModule = () => moduleRef.close();

      for (const [id, label] of [
        [A, 'a'],
        [B, 'b'],
        [C, 'c'],
        [D, 'd'],
      ] as const) {
        await admin.tenant.create({
          data: { id, slug: `pc-${label}-${stamp}`, name: `Aula ${label}` },
        });
        await admin.tenantDomain.create({
          data: {
            tenantId: id,
            hostname: `pc-${label}-${stamp}.didacta.test`,
            isPrimary: true,
            isVerified: true,
          },
        });
        await admin.modPayoutsAccount.create({
          data: {
            id: ACCOUNT_ID[id]!,
            tenantId: id,
            stripeAccountId: ACCT[id]!,
            country: 'ES',
            entityType: 'individual',
            status: 'READY',
            readyAt: new Date(),
          },
        });
      }

      fake.on('POST', '/v1/transfers', (req, f) => {
        const transfer = {
          id: `${f.nextId('tr')}_${stamp}`,
          object: 'transfer',
          amount: req.params['amount'],
          amount_reversed: 0,
          currency: req.params['currency'],
          destination: req.params['destination'],
          transfer_group: req.params['transfer_group'],
          metadata: req.params['metadata'] ?? {},
          balance_transaction: `${f.nextId('txn')}_${stamp}`,
          created: Math.floor(Date.now() / 1000),
          livemode: false,
        };
        transfers.push(transfer);
        f.seed(transfer);
        return transfer;
      });
      fake.on('GET', '/v1/transfers', (req) => ({
        object: 'list',
        has_more: false,
        data: transfers
          .map((t) => fake.get(t['id'] as string)!)
          .filter(
            (t) =>
              (req.params['transfer_group'] === undefined ||
                t['transfer_group'] === req.params['transfer_group']) &&
              (req.params['destination'] === undefined ||
                t['destination'] === req.params['destination']),
          )
          .reverse(),
      }));

      const stripeResolver = new TenantStripeResolverService(
        { get: async () => undefined } as never,
        async () => false,
      );
      runtime = new PayoutsRuntime(
        CONFIG,
        fake,
        prisma,
        stripeResolver,
        logger as never,
        undefined,
        undefined,
        undefined,
        cipher,
        silentVies,
      );
      const audit = new PrismaAuditLogService(prisma);
      payoutsController = new AdminTenantsPayoutsController(runtime, audit);

      const theming = new ThemingService(
        prisma as never,
        { logger: { info: () => undefined, warn: () => undefined } } as never,
      );
      const service = new AdminTenantsService(
        prisma,
        audit,
        {} as never,
        {} as never,
        logger as never,
        undefined,
        undefined,
        undefined,
        { getThemingService: () => theming } as never,
        undefined,
      );
      tenantsController = new AdminTenantsController(service, {} as never, {} as never);
      reconciler = new PayoutsReconcilerService({
        db: runtime.db,
        stripe: fake,
        settlement: runtime.settlement,
        replayEvent: async () => ({ outcome: 'ignored' }),
        logger: logger as never,
      });
    } finally {
      process.env['DATABASE_URL'] = previous.url;
      if (previous.mode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previous.mode;
    }
  }, 90_000);

  afterAll(async () => {
    // El libro y las facturas son de solo inserción (triggers): se quedan en la
    // base desechable. Las cuentas se cierran para otros barridos.
    await admin?.modPayoutsAccount.updateMany({
      where: { tenantId: { in: [A, B, C, D] } },
      data: { closedAt: new Date(), status: 'DISCONNECTED' },
    });
    await closeModule?.();
    await admin?.$disconnect();
  });

  let seq = 0;
  async function ledgerEntry(
    tenantId: string,
    type: 'PLATFORM_FEE' | 'PLATFORM_FEE_REFUND',
    amount: number,
    at: string,
    currency = 'eur',
  ) {
    await admin.modPayoutsLedgerEntry.create({
      data: {
        tenantId,
        accountId: ACCOUNT_ID[tenantId]!,
        type,
        amount,
        currency,
        idempotencyKey: `pc:${stamp}:${++seq}`,
        occurredAt: new Date(at),
      },
    });
  }

  // ── A.1 fees ──────────────────────────────────────────────────────────

  it('payouts/fees: cobrada y devuelta por aula, día UTC y divisa, leyendo el libro de todas las aulas', async () => {
    // Un rango propio (2031) para no mezclarse con lo que haya en la base.
    await ledgerEntry(A, 'PLATFORM_FEE', -500, '2031-03-10T10:00:00Z');
    await ledgerEntry(A, 'PLATFORM_FEE', -150, '2031-03-10T23:59:59Z');
    await ledgerEntry(A, 'PLATFORM_FEE_REFUND', 200, '2031-03-12T09:00:00Z');
    await ledgerEntry(A, 'PLATFORM_FEE', -500, '2031-03-10T10:00:00Z', 'usd');
    await ledgerEntry(B, 'PLATFORM_FEE', -300, '2031-03-11T00:00:00Z');
    await ledgerEntry(B, 'PLATFORM_FEE', -999, '2031-03-13T00:00:00Z'); // fuera: `to` incluye el 12

    const all = await payoutsController.getPayoutsFees(machineReq as never, undefined, {
      from: '2031-03-10',
      to: '2031-03-12',
    });
    // La base desechable guarda lo de pasadas anteriores (el libro es de solo
    // inserción): se mira solo lo de las aulas de ESTA pasada.
    const rows = all.filter((r) => r.tenantId === A || r.tenantId === B);
    expect(rows).toEqual(
      [
        { tenantId: A, day: '2031-03-10', currency: 'eur', feeCollected: 650, feeReturned: 0 },
        { tenantId: A, day: '2031-03-10', currency: 'usd', feeCollected: 500, feeReturned: 0 },
        { tenantId: B, day: '2031-03-11', currency: 'eur', feeCollected: 300, feeReturned: 0 },
        { tenantId: A, day: '2031-03-12', currency: 'eur', feeCollected: 0, feeReturned: 200 },
      ].sort(
        (x, y) =>
          x.day.localeCompare(y.day) ||
          x.tenantId.localeCompare(y.tenantId) ||
          x.currency.localeCompare(y.currency),
      ),
    );
  });

  // ── A.2–A.4 resumen, facturas y PDF ──────────────────────────────────

  it('summary, invoices y pdf: solo el aula de la URL; el PDF y la factura de otra aula no existen (404)', async () => {
    // Una venta cobrada y transferida de A (con su comisión) y su factura.
    const saleId = randomUUID();
    await admin.modPayoutsSale.create({
      data: {
        id: saleId,
        tenantId: A,
        accountId: ACCOUNT_ID[A]!,
        sourceKind: 'ORDER',
        sourceRef: randomUUID(),
        description: 'Curso de prueba',
        stripeChargeId: `ch_pc_${stamp}`,
        presentmentAmount: 10000,
        presentmentCurrency: 'eur',
        gross: 10000,
        stripeFee: 175,
        platformFee: 500,
        creatorNet: 9325,
        transferAmount: 9325,
        feeBpsApplied: 500,
        currency: 'eur',
        status: 'TRANSFERRED',
        chargedAt: new Date('2031-04-05T10:00:00Z'),
        transferredAt: new Date('2031-04-05T11:00:00Z'),
      },
    });
    await admin.modPayoutsLedgerEntry.create({
      data: {
        tenantId: A,
        accountId: ACCOUNT_ID[A]!,
        saleId,
        type: 'PLATFORM_FEE',
        amount: -500,
        currency: 'eur',
        idempotencyKey: `pc:${stamp}:${++seq}:invoice`,
        occurredAt: new Date('2031-04-05T10:00:00Z'),
      },
    });
    await runtime.taxProfiles!.save(
      A,
      {
        entityType: 'individual',
        legalName: 'Jenny Rosen',
        country: 'ES',
        taxId: '12345678Z',
        address: { line1: 'Calle Mayor 1', postalCode: '28013', city: 'Madrid', region: 'Madrid' },
        birthDate: '1990-02-28',
      },
      null,
    );
    await runtime.invoices!.issueForTenant(A, '2031-04');

    const summaryA = await payoutsController.getPayoutsSummary(machineReq as never, undefined, A);
    expect(summaryA.operatorName).toBe('Didacta');
    expect(summaryA.feeBps).toBe(500);
    expect(summaryA.currencies).toEqual([
      expect.objectContaining({ currency: 'eur', salesCount: 1, gross: 10000, platformFees: 500 }),
    ]);
    // CONTROL: el aula B no ve ni una venta de A.
    const summaryB = await payoutsController.getPayoutsSummary(machineReq as never, undefined, B);
    expect(summaryB.currencies).toEqual([]);

    const listA = await payoutsController.getPayoutsInvoices(machineReq as never, undefined, A);
    expect(listA.enabled).toBe(true);
    expect(listA.items).toHaveLength(1);
    const invoiceId = listA.items[0]!.id;
    const listB = await payoutsController.getPayoutsInvoices(machineReq as never, undefined, B);
    expect(listB).toEqual({ enabled: true, items: [] });

    const pdfFor = async (tenantId: string, id: string) => {
      const headers: Record<string, string> = {};
      let body: unknown;
      const reply = {
        header(name: string, value: string) {
          headers[name.toLowerCase()] = value;
          return reply;
        },
        send(payload: unknown) {
          body = payload;
          return reply;
        },
      };
      await payoutsController.getPayoutsInvoicePdf(
        machineReq as never,
        undefined,
        tenantId,
        id,
        reply as never,
      );
      return { headers, body: body as Buffer };
    };
    const pdf = await pdfFor(A, invoiceId);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['cache-control']).toBe('private, no-store');
    expect(pdf.headers['content-disposition']).toMatch(
      /^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/,
    );
    expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // CONTROL con la base de verdad: la MISMA factura pedida desde el aula B no existe.
    await expect(pdfFor(B, invoiceId)).rejects.toMatchObject({ code: 'PAYOUTS_INVOICE_NOT_FOUND' });
    await expect(pdfFor(A, randomUUID())).rejects.toMatchObject({
      code: 'PAYOUTS_INVOICE_NOT_FOUND',
    });
    await expect(pdfFor(A, 'no-es-un-uuid')).rejects.toMatchObject({
      code: 'PAYOUTS_INVOICE_NOT_FOUND',
    });
  });

  // ── A.5 crédito ───────────────────────────────────────────────────────

  const credit = (tenantId: string, patch: Record<string, unknown> = {}) =>
    payoutsController.createPayoutsCredit(machineReq as never, undefined, tenantId, {
      amount: 1250,
      currency: 'eur',
      idempotencyKey: `aff:${stamp}:eur:2031-W10`,
      reason: 'Afiliación 2031-W10',
      ...patch,
    });

  it('crédito: UNA clave = UNA transferencia aunque lleguen cinco peticiones a la vez; libro suma 0; conciliador limpio; audit una vez', async () => {
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => credit(C)));
    const ok = settled.filter((s) => s.status === 'fulfilled') as Array<
      PromiseFulfilledResult<{ transferId: string }>
    >;
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // Los que fallaron lo hicieron por un bloqueo transitorio de Stripe (reintentable), no por otra cosa.
    for (const s of settled.filter((x) => x.status === 'rejected')) {
      expect((s as PromiseRejectedResult).reason).toMatchObject({
        code: 'PAYOUTS_STRIPE_API_ERROR',
      });
    }
    // Un reintento posterior, ya sin carreras, siempre contesta lo mismo.
    const again = await credit(C);
    const mine = transfers.filter(
      (t) => (t['metadata'] as Record<string, string>)['didacta_tenant_id'] === C,
    );
    expect(mine).toHaveLength(1);
    expect(again.transferId).toBe(mine[0]!['id']);
    for (const s of ok) expect(s.value.transferId).toBe(mine[0]!['id']);
    expect(again).toEqual({
      status: 'transferred',
      transferId: mine[0]!['id'],
      amount: 1250,
      currency: 'eur',
    });

    const entries = await admin.modPayoutsLedgerEntry.findMany({
      where: { tenantId: C, idempotencyKey: { startsWith: 'payouts:credit:' } },
    });
    expect(entries.map((e) => `${e.type}:${e.amount}`).sort()).toEqual([
      'ADJUSTMENT:1250',
      'TRANSFER:-1250',
    ]);
    expect(entries.every((e) => e.saleId === null && e.accountId === ACCOUNT_ID[C])).toBe(true);
    expect(entries.find((e) => e.type === 'ADJUSTMENT')!.metadata).toMatchObject({
      cause: 'affiliate_credit',
      idempotencyKey: `aff:${stamp}:eur:2031-W10`,
    });

    // El conciliador no ve ninguna violación en las cuentas de este test.
    const { violations } = await reconciler.checkInvariants(null);
    expect(violations.filter((v) => v.tenantId === C || v.tenantId === D)).toEqual([]);
    // CONTROL: el conciliador no es ciego. El libro de B, con comisiones sembradas
    // sin su venta, sí queda marcado.
    expect(violations.some((v) => v.tenantId === B && v.kind === 'account_balance')).toBe(true);

    // Una sola fila de audit, la del primero (reintentos y carreras no la duplican).
    const audit = await admin.auditLog.findMany({
      where: { tenantId: C, action: 'payouts.credit.transferred' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(machineReq.provisioningActor.credentialId);
    expect(audit[0]!.metadata).toMatchObject({
      transferId: mine[0]!['id'],
      actorKind: 'provisioning',
    });

    // CONTROL de RLS: el aula D no ve ninguno de esos asientos (ni con la clave de C).
    const seenByD = await runtime.db.inTenant(D, (tx) =>
      tx.modPayoutsLedgerEntry.findMany({
        where: { idempotencyKey: { startsWith: 'payouts:credit:' } },
      }),
    );
    expect(seenByD).toEqual([]);
  });

  it('crédito: la misma clave con otro importe → 409 y nada nuevo; la misma cadena en OTRA aula es otro crédito, a su cuenta', async () => {
    const before = transfers.length;
    await expect(credit(C, { amount: 1251 })).rejects.toMatchObject({
      code: 'PAYOUTS_CREDIT_IDEMPOTENCY_CONFLICT',
    });
    expect(transfers).toHaveLength(before);

    const forB = await credit(D);
    expect(transfers).toHaveLength(before + 1);
    expect(transfers.at(-1)!['destination']).toBe(ACCT[D]);
    expect(forB.transferId).not.toBe((await credit(C)).transferId);
  });

  it('crédito: cuenta restringida → NO_ACCOUNT sin mover nada; el reintento de un crédito ya pagado sigue contestando', async () => {
    const paid = await credit(C);
    const before = transfers.length;
    await admin.modPayoutsAccount.update({
      where: { id: ACCOUNT_ID[C]! },
      data: { status: 'RESTRICTED' },
    });
    try {
      await expect(
        credit(C, { idempotencyKey: `aff:${stamp}:eur:2031-W11` }),
      ).rejects.toMatchObject({
        code: 'PAYOUTS_CREDIT_NO_ACCOUNT',
      });
      expect(transfers).toHaveLength(before);
      await expect(credit(C)).resolves.toEqual(paid);
    } finally {
      await admin.modPayoutsAccount.update({
        where: { id: ACCOUNT_ID[C]! },
        data: { status: 'READY' },
      });
    }
  });

  it('crédito: un aula inexistente o que no es un UUID → 404 y ni se mira Stripe', async () => {
    const before = fake.calls.length;
    await expect(credit(randomUUID())).rejects.toMatchObject({
      response: { code: 'ADMIN_TENANT_NOT_FOUND' },
    });
    await expect(credit('no-es-un-uuid')).rejects.toMatchObject({
      response: { code: 'ADMIN_TENANT_NOT_FOUND' },
    });
    expect(fake.calls).toHaveLength(before);
  });

  // ── A.6 y A.7 marca ───────────────────────────────────────────────────

  it('branding: lee nombre, color y dominio; el color y el nombre se escriben con su rastro y solo en el aula pedida', async () => {
    const first = await tenantsController.getBranding(machineReq as never, undefined, A);
    expect(first).toEqual({
      name: 'Aula a',
      primaryColor: null, // sin tema propio todavía: no se crea al leer
      slug: `pc-a-${stamp}`,
      primaryHostname: `pc-a-${stamp}.didacta.test`,
    });
    expect(await admin.modThemingTenantTheme.count({ where: { tenantId: A } })).toBe(0);

    const saved = await tenantsController.setBranding(machineReq as never, undefined, A, {
      name: 'Mi academia de pruebas',
      primaryColor: '#E11D48',
    });
    expect(saved.name).toBe('Mi academia de pruebas');
    const theme = await admin.modThemingTenantTheme.findUniqueOrThrow({ where: { tenantId: A } });
    expect(saved.primaryColor).toBe(brandToHex(theme.brandHue, theme.brandSaturation));
    expect(saved.primaryColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(await tenantsController.getBranding(machineReq as never, undefined, A)).toEqual(saved);

    // Audit del aula A: renombrado y color, ambos marcados como de la máquina.
    const rows = await admin.auditLog.findMany({
      where: {
        tenantId: A,
        action: { in: ['admin.tenant.renamed', 'admin.tenant.branding_color_changed'] },
      },
    });
    expect(rows.map((r) => r.action).sort()).toEqual([
      'admin.tenant.branding_color_changed',
      'admin.tenant.renamed',
    ]);
    for (const row of rows) expect(row.metadata).toMatchObject({ actorKind: 'provisioning' });

    // CONTROL: el aula B ni su tema ni su nombre se han tocado.
    expect(await admin.modThemingTenantTheme.count({ where: { tenantId: B } })).toBe(0);
    expect((await admin.tenant.findUniqueOrThrow({ where: { id: B } })).name).toBe('Aula b');

    // Repetir el mismo PUT no escribe nada más.
    const auditBefore = await admin.auditLog.count({ where: { tenantId: A } });
    await tenantsController.setBranding(machineReq as never, undefined, A, {
      name: 'Mi academia de pruebas',
      primaryColor: saved.primaryColor!,
    });
    expect(await admin.auditLog.count({ where: { tenantId: A } })).toBe(auditBefore);
  });
});
