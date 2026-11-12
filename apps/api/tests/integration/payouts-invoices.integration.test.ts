/**
 * Datos fiscales del creador y factura mensual de la comisión contra un
 * Postgres REAL, conectando como el runtime de producción: rol `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS) y RLS forzada.
 *
 * Lo que solo se ve con la base de verdad:
 *  - la numeración correlativa SIN HUECOS con emisores concurrentes (el
 *    contador por serie se avanza en la misma transacción que la factura) y
 *    tras una emisión que falla a medias;
 *  - un asiento del libro se factura una sola vez (índice único);
 *  - la factura emitida es inmutable (trigger de `rls.sql`): ni cambiar el
 *    total ni borrarla; sí rotar su bloque cifrado;
 *  - la RLS de facturas y datos fiscales entre aulas;
 *  - el cálculo de punta a punta: IVA incluido en el 5 %, varias monedas,
 *    reembolsos del mismo mes y de un mes ya facturado (rectificativa), la
 *    sustitución al completar los datos o validar el NIF-IVA, y el NIF
 *    guardado cifrado.
 *
 * De verdad: `PayoutsRuntime` con su cifrador, el servicio de datos fiscales,
 * el de facturas y el PDF. Simulado: Stripe (no se usa) y VIES.
 *
 * REQUISITOS: los de `rls-isolation-didacta-app.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import {
  InMemoryPlatformStripeClient,
  PayoutsInvoicesService,
  PayoutsTaxProfileService,
  type ViesClient,
  type ViesResult,
} from '@didacta/mod-payouts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

/** Serie propia de esta pasada: la numeración empieza en 1 aunque la base ya tenga otras. */
const SERIES = Array.from({ length: 4 }, () =>
  String.fromCharCode(65 + Math.floor(Math.random() * 26)),
).join('');

const CONFIG = loadPlatformPaymentsConfig({
  PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_inventadaFacturas',
  PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: 'whsec_operador_facturas',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_NAME: 'VA360 LABS, S.L.',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_TAX_ID: 'B24805335',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_VAT_ID: 'ESB24805335',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_ADDRESS_LINE1: 'C/ Juan José Sánchez Rodríguez, 24',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_POSTAL_CODE: '11630',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_CITY: 'Arcos de la Frontera',
  PAYMENTS_PLATFORM_INVOICE_ISSUER_REGION: 'Cádiz',
  PAYMENTS_PLATFORM_INVOICE_SERIES: SERIES,
}) as PlatformPaymentsEnabled;

/** VIES de mentira: lo que diga `answers` por número; cuenta las llamadas. */
class FakeVies implements ViesClient {
  calls: string[] = [];
  answers = new Map<string, ViesResult['status']>();
  async check(prefix: string, number: string): Promise<ViesResult> {
    this.calls.push(`${prefix}${number}`);
    const status = this.answers.get(`${prefix}${number}`) ?? 'unavailable';
    return status === 'unavailable'
      ? { status, checkedAt: new Date(), detail: 'MS_UNAVAILABLE' }
      : { status, checkedAt: new Date(), consultation: `WAPI${number}` };
  }
}

const ES_ADDRESS = {
  line1: 'Calle Mayor 1',
  postalCode: '28013',
  city: 'Madrid',
  region: 'Madrid',
};

describeWithDb('Datos fiscales y facturas de la comisión — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let runtime: PayoutsRuntime;
  let invoices: PayoutsInvoicesService;
  let taxProfiles: PayoutsTaxProfileService;
  const vies = new FakeVies();
  const cipher = new SecretCipherService('ab'.repeat(32));
  const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
  const stamp = Date.now();
  const tenants: string[] = [];
  const accountOf = new Map<string, string>();

  async function newTenant(label: string, country = 'ES', entityType = 'individual') {
    const id = randomUUID();
    const accountId = randomUUID();
    await admin.tenant.create({
      data: { id, slug: `fac-${label}-${stamp}`, name: `Aula ${label}` },
    });
    await admin.modPayoutsAccount.create({
      data: {
        id: accountId,
        tenantId: id,
        stripeAccountId: `acct_1Fac${label}${stamp}`,
        country,
        entityType,
        status: 'READY',
        readyAt: new Date(),
      },
    });
    tenants.push(id);
    accountOf.set(id, accountId);
    return id;
  }

  let seq = 0;
  /** Venta con su comisión ya sellada (asiento PLATFORM_FEE) en la fecha dada. */
  async function sale(
    tenantId: string,
    input: { gross: number; fee: number; currency?: string; at: string; description?: string },
  ) {
    const saleId = randomUUID();
    const currency = input.currency ?? 'eur';
    const n = ++seq;
    await admin.modPayoutsSale.create({
      data: {
        id: saleId,
        tenantId,
        accountId: accountOf.get(tenantId)!,
        sourceKind: 'ORDER',
        sourceRef: randomUUID(),
        description: input.description ?? `Curso ${n}`,
        stripeChargeId: `ch_fac_${stamp}_${n}`,
        presentmentAmount: input.gross,
        presentmentCurrency: currency,
        gross: input.gross,
        platformFee: input.fee,
        currency,
        status: 'TRANSFERRED',
        chargedAt: new Date(input.at),
      },
    });
    await admin.modPayoutsLedgerEntry.create({
      data: {
        tenantId,
        accountId: accountOf.get(tenantId)!,
        saleId,
        type: 'PLATFORM_FEE',
        amount: -input.fee,
        currency,
        idempotencyKey: `fac:${stamp}:${n}:fee`,
        occurredAt: new Date(input.at),
      },
    });
    return saleId;
  }

  /** Devolución de comisión (reembolso) de una venta, en la fecha dada. */
  async function feeRefund(
    tenantId: string,
    saleId: string,
    amount: number,
    at: string,
    currency = 'eur',
  ) {
    await admin.modPayoutsLedgerEntry.create({
      data: {
        tenantId,
        accountId: accountOf.get(tenantId)!,
        saleId,
        type: 'PLATFORM_FEE_REFUND',
        amount,
        currency,
        idempotencyKey: `fac:${stamp}:${++seq}:refund`,
        occurredAt: new Date(at),
      },
    });
  }

  async function invoicesOf(tenantId: string) {
    return admin.modPayoutsInvoice.findMany({
      where: { tenantId },
      include: { items: true },
      orderBy: [{ createdAt: 'asc' }],
    });
  }

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
      const stripeResolver = new TenantStripeResolverService(
        { get: async () => undefined } as never,
        async () => false,
      );
      runtime = new PayoutsRuntime(
        CONFIG,
        new InMemoryPlatformStripeClient({ livemode: false }),
        prisma,
        stripeResolver,
        logger as never,
        undefined,
        undefined,
        undefined,
        cipher,
        vies,
      );
      invoices = runtime.invoices!;
      taxProfiles = runtime.taxProfiles!;
    } finally {
      process.env['DATABASE_URL'] = previous.url;
      if (previous.mode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previous.mode;
    }
  }, 90_000);

  afterAll(async () => {
    // Las facturas y el libro no se borran (triggers): se quedan en la base
    // desechable. Las cuentas se cierran para otros barridos.
    await admin?.modPayoutsAccount.updateMany({
      where: { tenantId: { in: tenants } },
      data: { closedAt: new Date(), status: 'DISCONNECTED' },
    });
    await closeModule?.();
    await admin?.$disconnect();
  });

  it('el runtime monta datos fiscales y facturas solo con cifrador y emisor', () => {
    expect(runtime.invoices).not.toBeNull();
    expect(runtime.taxProfiles?.required).toBe(true);
    const withoutCipher = new PayoutsRuntime(
      CONFIG,
      new InMemoryPlatformStripeClient({ livemode: false }),
      prisma,
      {} as never,
      logger as never,
    );
    expect(withoutCipher.taxProfiles).toBeNull();
    expect(withoutCipher.invoices).toBeNull();
  });

  describe('datos fiscales', () => {
    it('guarda el NIF CIFRADO (ni en claro en la fila ni en la vista), valida el control y libera las ventas retenidas', async () => {
      const A = await newTenant('dfA');
      const held = await sale(A, { gross: 10000, fee: 500, at: '2026-10-05T10:00:00Z' });
      await admin.modPayoutsSale.update({
        where: { id: held },
        data: {
          status: 'HELD',
          stripeTransferId: null,
          lastError: 'tax_profile_incomplete: faltan los datos fiscales del creador',
          nextAttemptAt: new Date('2099-01-01T00:00:00Z'),
        },
      });
      expect(await taxProfiles.transferBlockReason(A)).toBe('tax_profile_incomplete');

      await expect(
        taxProfiles.save(
          A,
          {
            entityType: 'individual',
            legalName: 'Jenny Rosen',
            country: 'ES',
            taxId: '12345678A',
            address: ES_ADDRESS,
            birthDate: '1990-02-28',
          },
          null,
        ),
      ).rejects.toMatchObject({ code: 'PAYOUTS_TAX_PROFILE_INVALID', detail: 'taxId:check_digit' });
      expect(await admin.modPayoutsTaxProfile.count({ where: { tenantId: A } })).toBe(0);

      const result = await taxProfiles.save(
        A,
        {
          entityType: 'individual',
          legalName: 'Jenny Rosen',
          country: 'ES',
          taxId: '12345678Z',
          address: ES_ADDRESS,
          birthDate: '1990-02-28',
        },
        null,
      );
      expect(result.becameComplete).toBe(true);
      expect(result.releasedSales).toBe(1);
      expect(result.view).toMatchObject({
        status: 'complete',
        missing: [],
        profile: { taxIdHint: '678Z', birthDate: '1990-02-28' },
      });
      expect(JSON.stringify(result.view)).not.toContain('12345678Z');
      const row = await admin.modPayoutsTaxProfile.findUniqueOrThrow({ where: { tenantId: A } });
      expect(Buffer.from(row.sensitiveCipher).toString('latin1')).not.toContain('12345678');
      expect(Buffer.from(row.sensitiveCipher).toString('latin1')).not.toContain('Mayor');
      expect(row.complete).toBe(true);
      const released = await admin.modPayoutsSale.findUniqueOrThrow({ where: { id: held } });
      expect(released.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect(await taxProfiles.transferBlockReason(A)).toBeNull();
      // Corregir sin volver a escribir el NIF: se conserva el guardado.
      const again = await taxProfiles.save(
        A,
        {
          entityType: 'individual',
          legalName: 'Jenny Rosen García',
          country: 'ES',
          address: ES_ADDRESS,
          birthDate: '1990-02-28',
        },
        null,
      );
      expect(again.view.profile?.taxIdHint).toBe('678Z');
      expect((await taxProfiles.full(A))?.taxId).toBe('12345678Z');
    });

    it('VIES con caché por número; si no responde, «pendiente» sin bloquear (y la validación previa sigue valiendo)', async () => {
      const D = await newTenant('dfD', 'DE', 'company');
      vies.answers.set('DE811115368', 'valid');
      const input = {
        entityType: 'company' as const,
        legalName: 'Lernen GmbH',
        country: 'DE',
        taxId: '1234567890',
        vatId: 'DE 811 115 368',
        address: { line1: 'Hauptstraße 1', postalCode: '10115', city: 'Berlin' },
      };
      const first = await taxProfiles.save(D, input, null);
      expect(first.view.profile?.vatStatus).toBe('valid');
      const callsAfterFirst = vies.calls.filter((c) => c === 'DE811115368').length;
      await taxProfiles.save(D, { ...input, legalName: 'Lernen GmbH & Co' }, null);
      expect(vies.calls.filter((c) => c === 'DE811115368').length).toBe(callsAfterFirst);

      // VIES cae: el número ya validado sigue valiendo; uno nuevo queda pendiente.
      vies.answers.delete('DE811115368');
      expect(await taxProfiles.refreshVat(D, { force: true })).toBe('valid');
      const pending = await taxProfiles.save(D, { ...input, vatId: 'DE999999999' }, null);
      expect(pending.view).toMatchObject({ status: 'complete', profile: { vatStatus: 'pending' } });
    });

    it('RLS: un aula no ve los datos fiscales de otra', async () => {
      const X = await newTenant('dfX');
      const Y = await newTenant('dfY');
      await taxProfiles.save(
        X,
        {
          entityType: 'company',
          legalName: 'Equis SL',
          country: 'ES',
          taxId: 'B24805335',
          address: ES_ADDRESS,
        },
        null,
      );
      expect((await taxProfiles.view(Y)).status).toBe('missing');
      expect(await taxProfiles.full(Y)).toBeNull();
    });
  });

  describe('factura del mes', () => {
    it('creador de España: 5 % con el IVA incluido, reembolso del mismo mes en la misma factura, una sola por mes', async () => {
      const A = await newTenant('fES');
      await taxProfiles.save(
        A,
        {
          entityType: 'individual',
          legalName: 'Ana Pérez',
          country: 'ES',
          taxId: '12345678Z',
          address: ES_ADDRESS,
          birthDate: '1985-05-05',
        },
        null,
      );
      await sale(A, { gross: 10000, fee: 500, at: '2026-09-03T10:00:00Z', description: 'Curso A' });
      await sale(A, { gross: 3000, fee: 150, at: '2026-09-10T10:00:00Z', description: 'Curso B' });
      const refunded = await sale(A, { gross: 10000, fee: 500, at: '2026-09-12T10:00:00Z' });
      await feeRefund(A, refunded, 500, '2026-09-20T10:00:00Z');
      // Del 30 de septiembre a las 23:30 de Madrid (21:30 UTC): es de septiembre.
      await sale(A, {
        gross: 2900,
        fee: 145,
        at: '2026-09-30T21:30:00Z',
        description: 'Membresía',
      });
      // Del 1 de octubre a las 00:30 de Madrid (30-sep 22:30 UTC): NO es de septiembre.
      await sale(A, {
        gross: 4900,
        fee: 245,
        at: '2026-09-30T22:30:00Z',
        description: 'Curso octubre',
      });

      const report = await invoices.runMonth('2026-09', { tenantId: A });
      expect(report.issued).toBe(1);
      const [invoice] = await invoicesOf(A);
      // 500 + 150 + 500 − 500 + 145 = 795 → base 657 (795 / 1,21 = 657,02) + IVA 138
      expect(invoice).toMatchObject({
        kind: 'ORDINARY',
        regime: 'ES_VAT',
        vatRateBps: 2100,
        total: 795,
        taxBase: 657,
        vatAmount: 138,
        currency: 'eur',
        recipientLegalName: 'Ana Pérez',
        recipientComplete: true,
        slot: 'ord:2026-09:eur',
      });
      expect(invoice!.fullNumber).toMatch(new RegExp(`^${SERIES}T-\\d{4}-\\d{6}$`));
      expect(invoice!.periodStart.toISOString().slice(0, 10)).toBe('2026-09-01');
      expect(invoice!.periodEnd.toISOString().slice(0, 10)).toBe('2026-09-30');
      expect(invoice!.items.map((i) => i.amount).sort((a, b) => a - b)).toEqual([
        -500, 145, 150, 500, 500,
      ]);

      // Repetir el proceso no duplica; la venta del 1 de octubre va a octubre.
      const repeat = await invoices.runMonth('2026-09', { tenantId: A });
      expect(repeat.issued).toBe(0);
      expect(await admin.modPayoutsInvoice.count({ where: { tenantId: A } })).toBe(1);
      await invoices.runMonth('2026-10', { tenantId: A });
      const all = await invoicesOf(A);
      expect(all).toHaveLength(2);
      expect(all[1]).toMatchObject({
        slot: 'ord:2026-10:eur',
        total: 245,
        taxBase: 202,
        vatAmount: 43,
      });

      // El PDF que se descarga es el que se guardó cifrado al emitir.
      const pdf = await invoices.pdf(A, invoice!.id);
      expect(pdf.fileName).toBe(`${invoice!.fullNumber}.pdf`);
      expect(pdf.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(Buffer.from(invoice!.documentCipher).toString('latin1')).not.toContain('%PDF');
    });

    it('reembolso de una venta ya facturada en un mes anterior → rectificativa que la nombra (serie R)', async () => {
      const B = await newTenant('fRect');
      await taxProfiles.save(
        B,
        {
          entityType: 'company',
          legalName: 'Bee Formación SL',
          country: 'ES',
          taxId: 'B24805335',
          address: ES_ADDRESS,
        },
        null,
      );
      const s1 = await sale(B, {
        gross: 10000,
        fee: 500,
        at: '2026-08-10T10:00:00Z',
        description: 'Curso grande',
      });
      await sale(B, { gross: 3000, fee: 150, at: '2026-08-11T10:00:00Z' });
      await invoices.runMonth('2026-08', { tenantId: B });
      const [august] = await invoicesOf(B);
      expect(august!.total).toBe(650);

      // Reembolso parcial del 40 % en septiembre de la venta de agosto + una venta nueva.
      await feeRefund(B, s1, 200, '2026-09-04T10:00:00Z');
      await sale(B, { gross: 4900, fee: 245, at: '2026-09-06T10:00:00Z' });
      const report = await invoices.runMonth('2026-09', { tenantId: B });
      expect(report.issued).toBe(2);
      const all = await invoicesOf(B);
      const rect = all.find((i) => i.kind === 'RECTIFYING')!;
      const ordinary = all.find((i) => i.slot === 'ord:2026-09:eur')!;
      expect(ordinary).toMatchObject({ total: 245, taxBase: 202, vatAmount: 43 });
      // −200 → base −165 (−165,29) + IVA −35
      expect(rect).toMatchObject({
        slot: 'ref:2026-09:eur',
        total: -200,
        taxBase: -165,
        vatAmount: -35,
        rectifies: [
          { id: august!.id, fullNumber: august!.fullNumber, issueDate: expect.any(String) },
        ],
      });
      expect(rect.fullNumber).toMatch(new RegExp(`^${SERIES}TR-\\d{4}-\\d{6}$`));
      expect(rect.items).toHaveLength(1);
      expect(rect.items[0]).toMatchObject({
        type: 'COMMISSION_REFUND',
        amount: -200,
        originalInvoiceId: august!.id,
      });
      // La original no cambia: una rectificativa no la toca.
      expect(
        (await admin.modPayoutsInvoice.findUniqueOrThrow({ where: { id: august!.id } })).total,
      ).toBe(650);
    });

    it('varias monedas: una factura por moneda; fuera de la UE sin IVA y con su mención', async () => {
      const U = await newTenant('fUS', 'US', 'company');
      await taxProfiles.save(
        U,
        {
          entityType: 'company',
          legalName: 'Learn LLC',
          country: 'US',
          taxId: '12-3456789',
          address: { line1: '1 Main St', postalCode: '94105', city: 'San Francisco', region: 'CA' },
        },
        null,
      );
      await sale(U, { gross: 10000, fee: 500, currency: 'usd', at: '2026-09-02T10:00:00Z' });
      await sale(U, { gross: 9021, fee: 451, currency: 'usd', at: '2026-09-03T10:00:00Z' });
      await sale(U, { gross: 10000, fee: 500, currency: 'gbp', at: '2026-09-04T10:00:00Z' });
      const report = await invoices.runMonth('2026-09', { tenantId: U });
      expect(report.issued).toBe(2);
      const all = await invoicesOf(U);
      expect(
        all.map((i) => [i.currency, i.total, i.taxBase, i.vatAmount, i.regime]).sort(),
      ).toEqual([
        ['gbp', 500, 500, 0, 'NOT_SUBJECT_OUTSIDE_EU'],
        ['usd', 951, 951, 0, 'NOT_SUBJECT_OUTSIDE_EU'],
      ]);
      expect(new Set(all.map((i) => i.fullNumber)).size).toBe(2);
    });

    it('empresa de la UE con NIF-IVA válido → inversión del sujeto pasivo, sin IVA', async () => {
      const D = await newTenant('fDE', 'DE', 'company');
      vies.answers.set('DE811569869', 'valid');
      await taxProfiles.save(
        D,
        {
          entityType: 'company',
          legalName: 'Lernen AG',
          country: 'DE',
          taxId: '9876543210',
          vatId: 'DE811569869',
          address: { line1: 'Weg 2', postalCode: '80331', city: 'München' },
        },
        null,
      );
      await sale(D, { gross: 10000, fee: 500, at: '2026-09-02T10:00:00Z' });
      await invoices.runMonth('2026-09', { tenantId: D });
      const [invoice] = await invoicesOf(D);
      expect(invoice).toMatchObject({
        regime: 'EU_REVERSE_CHARGE',
        vatRateBps: 0,
        total: 500,
        taxBase: 500,
        vatAmount: 0,
      });
    });

    it('sin datos fiscales: sale igual (pendiente de completar) y al completarlos se SUSTITUYE por una rectificativa', async () => {
      const N = await newTenant('fNoData');
      await sale(N, { gross: 10000, fee: 500, at: '2026-09-02T10:00:00Z' });
      await invoices.runMonth('2026-09', { tenantId: N });
      const [first] = await invoicesOf(N);
      expect(first).toMatchObject({
        recipientComplete: false,
        recipientLegalName: 'Aula fNoData',
        regime: 'ES_VAT',
        total: 500,
      });
      // Sin datos completos todavía, no se sustituye.
      expect(await invoices.issueSubstitutions(N)).toEqual([]);

      await taxProfiles.save(
        N,
        {
          entityType: 'individual',
          legalName: 'Nora Díaz',
          country: 'ES',
          taxId: 'X1234567L',
          address: ES_ADDRESS,
          birthDate: '1979-12-31',
        },
        null,
      );
      const results = await invoices.issueSubstitutions(N);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ outcome: 'issued', kind: 'RECTIFYING' });
      const all = await invoicesOf(N);
      const original = all.find((i) => i.id === first!.id)!;
      const substitute = all.find((i) => i.id !== first!.id)!;
      expect(original.replacedById).toBe(substitute.id);
      expect(substitute).toMatchObject({
        slot: `sub:${first!.id}`,
        recipientComplete: true,
        recipientLegalName: 'Nora Díaz',
        total: 500,
        taxBase: 413,
        vatAmount: 87,
      });
      // Las líneas copiadas no vuelven a consumir los asientos.
      expect(substitute.items.every((i) => i.consumesLedgerEntryId === null)).toBe(true);
      expect(await invoices.issueSubstitutions(N)).toEqual([]);
    });

    it('UE con NIF-IVA aún pendiente: hasta el día 10 se espera; después, IVA español y se sustituye al validarse', async () => {
      const P = await newTenant('fPend', 'FR', 'company');
      vies.answers.delete('FR40303265045');
      await taxProfiles.save(
        P,
        {
          entityType: 'company',
          legalName: 'Apprendre SARL',
          country: 'FR',
          taxId: '30326504500017',
          vatId: 'FR40303265045',
          address: { line1: 'Rue 3', postalCode: '75001', city: 'Paris' },
        },
        null,
      );
      await sale(P, { gross: 10000, fee: 500, at: '2026-09-02T10:00:00Z' });
      const early = new PayoutsInvoicesService(runtime.db, cipher, taxProfiles, invoices.config, {
        now: () => new Date('2026-10-03T08:00:00Z'),
      });
      expect(await early.issueForTenant(P, '2026-09')).toEqual([
        { outcome: 'postponed', reason: 'vat_pending' },
      ]);
      const late = new PayoutsInvoicesService(runtime.db, cipher, taxProfiles, invoices.config, {
        now: () => new Date('2026-10-12T08:00:00Z'),
      });
      await late.issueForTenant(P, '2026-09');
      const [withVat] = await invoicesOf(P);
      expect(withVat).toMatchObject({
        regime: 'ES_VAT_EU_NO_VAT_ID',
        total: 500,
        taxBase: 413,
        vatAmount: 87,
      });

      vies.answers.set('FR40303265045', 'valid');
      expect(await taxProfiles.refreshVat(P, { force: true })).toBe('valid');
      await invoices.issueSubstitutions(P);
      const substitute = (await invoicesOf(P)).find((i) => i.id !== withVat!.id)!;
      expect(substitute).toMatchObject({
        kind: 'RECTIFYING',
        regime: 'EU_REVERSE_CHARGE',
        total: 500,
        taxBase: 500,
        vatAmount: 0,
      });
    });
  });

  describe('numeración, inmutabilidad y aislamiento', () => {
    it('12 aulas a la vez: 12 números seguidos, sin repetir ni saltar; un fallo a medias no gasta número', async () => {
      const many = await Promise.all(Array.from({ length: 12 }, (_, i) => newTenant(`par${i}`)));
      for (const t of many) await sale(t, { gross: 1000, fee: 50, at: '2026-07-15T10:00:00Z' });
      const before = await admin.modPayoutsInvoiceCounter.findUnique({
        where: { series: `${SERIES}T-2026` },
      });

      // Una de ellas falla DESPUÉS de reservar número (justo antes de confirmar).
      let failOnce = true;
      const flaky = new PayoutsInvoicesService(runtime.db, cipher, taxProfiles, invoices.config, {
        beforeCommit: () => {
          if (failOnce) {
            failOnce = false;
            throw new Error('caída simulada a mitad de la emisión');
          }
        },
      });
      const results = await Promise.allSettled(many.map((t) => flaky.issueForTenant(t, '2026-07')));
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      // Se reintenta la que falló.
      for (const [i, r] of results.entries()) {
        if (r.status === 'rejected') await invoices.issueForTenant(many[i]!, '2026-07');
      }
      const issued = await admin.modPayoutsInvoice.findMany({
        where: { tenantId: { in: many } },
        orderBy: { number: 'asc' },
      });
      expect(issued).toHaveLength(12);
      const numbers = issued.map((i) => i.number);
      const start = (before?.lastNumber ?? 0) + 1;
      expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => start + i));
      const after = await admin.modPayoutsInvoiceCounter.findUniqueOrThrow({
        where: { series: `${SERIES}T-2026` },
      });
      expect(after.lastNumber).toBe(start + 11);
    });

    it('la misma aula a la vez: una sola factura y ningún asiento facturado dos veces', async () => {
      const C = await newTenant('race');
      for (let i = 0; i < 5; i += 1)
        await sale(C, { gross: 1000, fee: 50, at: '2026-06-1' + i + 'T10:00:00Z' });
      const counterBefore = await admin.modPayoutsInvoiceCounter.findUnique({
        where: { series: `${SERIES}T-2026` },
      });
      const results = await Promise.all(
        Array.from({ length: 4 }, () => invoices.issueForTenant(C, '2026-06')),
      );
      const outcomes = results.flat().map((r) => r.outcome);
      expect(outcomes.filter((o) => o === 'issued')).toHaveLength(1);
      expect(await admin.modPayoutsInvoice.count({ where: { tenantId: C } })).toBe(1);
      expect(await admin.modPayoutsInvoiceItem.count({ where: { tenantId: C } })).toBe(5);
      const counterAfter = await admin.modPayoutsInvoiceCounter.findUniqueOrThrow({
        where: { series: `${SERIES}T-2026` },
      });
      // Los que perdieron la carrera no gastaron número.
      expect(counterAfter.lastNumber).toBe((counterBefore?.lastNumber ?? 0) + 1);
    });

    it('una factura emitida no se cambia ni se borra (sí se puede rotar su bloque cifrado); sus líneas tampoco', async () => {
      const I = await newTenant('inmut');
      await sale(I, { gross: 1000, fee: 50, at: '2026-05-10T10:00:00Z' });
      await invoices.runMonth('2026-05', { tenantId: I });
      const [invoice] = await invoicesOf(I);
      await expect(
        admin.modPayoutsInvoice.update({ where: { id: invoice!.id }, data: { total: 1 } }),
      ).rejects.toThrow(/inmutable/);
      await expect(
        admin.modPayoutsInvoice.update({ where: { id: invoice!.id }, data: { fullNumber: 'X-1' } }),
      ).rejects.toThrow(/inmutable/);
      await expect(admin.modPayoutsInvoice.delete({ where: { id: invoice!.id } })).rejects.toThrow(
        /no se borra/,
      );
      await expect(
        admin.modPayoutsInvoiceItem.update({
          where: { id: invoice!.items[0]!.id },
          data: { amount: 1 },
        }),
      ).rejects.toThrow(/solo inserción/);
      // Rotación de la clave: solo el bloque cifrado cambia (lo verifica rotate-cipher-key).
      const reencrypted = cipher.encrypt(
        cipher.decrypt({
          cipher: Buffer.from(invoice!.documentCipher),
          iv: Buffer.from(invoice!.documentIv),
          tag: Buffer.from(invoice!.documentTag),
        }),
      );
      await admin.modPayoutsInvoice.update({
        where: { id: invoice!.id },
        data: {
          documentCipher: reencrypted.cipher,
          documentIv: reencrypted.iv,
          documentTag: reencrypted.tag,
          emailedAt: new Date(),
        },
      });
      expect((await invoices.pdf(I, invoice!.id)).pdf.subarray(0, 5).toString('latin1')).toBe(
        '%PDF-',
      );
    });

    it('RLS: un aula no ve ni descarga las facturas de otra', async () => {
      const R1 = await newTenant('rls1');
      const R2 = await newTenant('rls2');
      await sale(R1, { gross: 1000, fee: 50, at: '2026-04-10T10:00:00Z' });
      await invoices.runMonth('2026-04', { tenantId: R1 });
      const [invoice] = await invoicesOf(R1);
      expect((await invoices.list(R1)).map((i) => i.id)).toEqual([invoice!.id]);
      expect(await invoices.list(R2)).toEqual([]);
      await expect(invoices.pdf(R2, invoice!.id)).rejects.toMatchObject({
        code: 'PAYOUTS_INVOICE_NOT_FOUND',
      });
    });
  });
});
