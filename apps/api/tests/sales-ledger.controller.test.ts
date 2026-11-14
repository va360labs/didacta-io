/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * «Ventas» con los datos de cada venta, sin base de datos: quién puede verlas
 * y exportarlas, de qué aula se leen (siempre la del token) y que exportar
 * deja rastro en la auditoría. El aislamiento con RLS real está en
 * `tests/integration/sales-ledger.integration.test.ts`.
 */

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { SessionClaims } from '../src/auth/token.service';
import { SalesLedgerController, exportFileName } from '../src/sales/sales-ledger.controller';
import { likePattern, toSaleRow } from '../src/sales/sales-ledger.service';
import {
  salesExportQuerySchema,
  salesListQuerySchema,
  type SaleRow,
} from '../src/sales/sales-ledger.types';

const A = '11111111-1111-4111-8111-111111111111';

function claims(roles: string[], extra: Partial<SessionClaims> = {}): SessionClaims {
  return { sub: 'user-1', tenantId: A, roles, ...extra } as SessionClaims;
}

const ROW: SaleRow = {
  id: 'order:7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7f',
  kind: 'order',
  at: '2026-11-14T12:05:00.000Z',
  buyer: {
    userId: 'u-1',
    name: 'Ana',
    email: 'ana@example.com',
    checkoutEmail: null,
    country: 'ES',
    deleted: false,
  },
  product: { kind: 'course', ref: 'course:c1', title: 'Curso', option: null, intervalMonths: null },
  amount: 4900,
  currency: 'eur',
  coupon: null,
  referralCredit: null,
  referral: null,
  settlement: null,
  status: 'paid',
  refundState: 'none',
  payoutSaleId: null,
};

function build() {
  const sales = {
    list: vi.fn(async (tenantId: string) => ({
      items: [ROW],
      page: 1,
      pageSize: 25,
      total: 1,
      totals: [],
      products: [],
      platform: null,
      tenantId,
    })),
    all: vi.fn(async () => ({ rows: [ROW], total: 1 })),
    detail: vi.fn(async (tenantId: string, id: string) => ({ tenantId, id })),
    platformInfo: vi.fn(async () => null),
  };
  // `academyLocale` / `academyTimeZone` leen ajustes y personas: el aula en inglés.
  const prisma = {
    tenantSetting: {
      findUnique: vi.fn(async () => ({ valueJson: 'en' })),
    },
    user: { findMany: vi.fn(async () => [{ locale: 'en-US', timezone: 'Europe/London' }]) },
    modZoomSession: { findFirst: vi.fn(async () => null) },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new SalesLedgerController(sales as never, prisma as never, audit as never);
  return { controller, sales, audit };
}

function reply() {
  const headers: Record<string, string> = {};
  let body: Buffer | null = null;
  const r = {
    header(k: string, v: string) {
      headers[k] = v;
      return r;
    },
    send(b: Buffer) {
      body = b;
      return r;
    },
  };
  return { r, headers, body: () => body };
}

const REQ = { headers: { 'user-agent': 'vitest' }, ip: '127.0.0.1' } as never;

describe('quién puede ver las ventas', () => {
  it('sin sesión, 401; un alumno o un formador, 403', async () => {
    const { controller, sales } = build();
    const q = salesListQuerySchema.parse({});
    await expect(controller.list(undefined, q)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.list(claims(['student']), q)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(controller.list(claims(['formador']), q)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(controller.detail(claims(['student']), ROW.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sales.list).not.toHaveBeenCalled();
    expect(sales.detail).not.toHaveBeenCalled();
  });

  it('quien administra lee las de SU aula (la del token), con sus filtros', async () => {
    const { controller, sales } = build();
    const q = salesListQuerySchema.parse({
      status: 'refunded',
      q: ' ana ',
      page: '2',
      pageSize: '10',
      from: '2026-11-01T00:00:00.000Z',
    });
    await controller.list(claims(['tenant_admin']), q);
    expect(sales.list).toHaveBeenCalledWith(
      A,
      { status: 'refunded', q: 'ana', from: new Date('2026-11-01T00:00:00.000Z') },
      { page: 2, pageSize: 10 },
    );
    await controller.detail(claims(['super_admin']), ROW.id);
    expect(sales.detail).toHaveBeenCalledWith(A, ROW.id);
  });

  it('los filtros se validan: estado y producto desconocidos son un 400', () => {
    expect(() => salesListQuerySchema.parse({ status: 'robada' })).toThrow();
    expect(() => salesListQuerySchema.parse({ product: 'curso-1' })).toThrow();
    expect(() => salesListQuerySchema.parse({ pageSize: '500' })).toThrow();
    expect(() => salesExportQuerySchema.parse({ format: 'pdf' })).toThrow();
    expect(
      salesListQuerySchema.parse({ product: 'plan:7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7f' }).product,
    ).toBe('plan:7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7f');
  });
});

describe('exportar', () => {
  it('deja en la auditoría quién exportó, con qué filtros y cuántas filas (RGPD)', async () => {
    const { controller, audit, sales } = build();
    const { r, headers, body } = reply();
    const q = salesExportQuerySchema.parse({ format: 'csv', status: 'paid' });
    await controller.export(REQ, r as never, claims(['tenant_admin']), q);
    expect(sales.all).toHaveBeenCalledWith(A, { status: 'paid' });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: A,
        actorId: 'user-1',
        action: 'sales.exported',
        resourceType: 'sales',
        metadata: expect.objectContaining({
          format: 'csv',
          view: 'sales',
          rows: 1,
          filters: expect.objectContaining({ status: 'paid', q: null }),
        }),
      }),
    );
    // En el idioma del aula (inglés): nombre, cabeceras y separador.
    expect(headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(headers['content-disposition']).toMatch(
      /attachment; filename="sales-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const text = (body() as unknown as Buffer).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Amount paid');
    expect(text).toContain('ana@example.com');
  });

  it('Excel y compradores también se exportan y se auditan', async () => {
    const { controller, audit } = build();
    const { r, headers } = reply();
    await controller.export(
      REQ,
      r as never,
      claims(['tenant_admin']),
      salesExportQuerySchema.parse({ format: 'xlsx', view: 'buyers' }),
    );
    expect(headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(headers['content-disposition']).toMatch(/buyers-.*\.xlsx/);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ format: 'xlsx', view: 'buyers' }),
      }),
    );
  });

  it('una sesión de soporte NO exporta datos personales; un alumno tampoco', async () => {
    const { controller, audit, sales } = build();
    const { r } = reply();
    const q = salesExportQuerySchema.parse({});
    await expect(
      controller.export(REQ, r as never, claims(['tenant_admin'], { sup: 'staff-1' } as never), q),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.export(REQ, r as never, claims(['student']), q)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sales.all).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('el nombre del fichero va en el idioma del aula', () => {
    const now = new Date('2026-11-14T10:00:00Z');
    expect(exportFileName('es', 'sales', 'csv', now)).toBe('ventas-2026-11-14.csv');
    expect(exportFileName('pt', 'sales', 'xlsx', now)).toBe('vendas-2026-11-14.xlsx');
    expect(exportFileName('en', 'buyers', 'csv', now)).toBe('buyers-2026-11-14.csv');
  });
});

describe('fila de una venta', () => {
  const base = {
    kind: 'order' as const,
    source_id: '7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7f',
    source_ref: '7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7f',
    user_id: 'u-1',
    course_id: 'c-1',
    plan_id: null,
    subscription_id: null,
    at: new Date('2026-11-14T12:05:00.000Z'),
    amount: 4900,
    currency: 'EUR',
    checkout_email: 'ANA.pago@example.com',
    country: 'PT',
    coupon: 500,
    credit: null,
    origin_refunded: false,
    origin_refunded_at: null,
    hosted_invoice_url: null,
    period_start: null,
    period_end: null,
    user_name: 'Ana',
    user_email: 'ana@example.com',
    user_deleted: false,
    course_title: 'Curso',
    option_name: null,
    plan_name: null,
    interval_months: null,
    payout_id: null,
    presentment_amount: null,
    presentment_currency: null,
    customer_credit_applied: null,
    payout_email: null,
    referrer_user_id: null,
    referrer_name: null,
    referral_code: null,
    commission_cents: null,
    commission_currency: null,
    commission_status: null,
    status: 'paid' as const,
  };

  it('el correo de su cuenta primero; el del pago, aparte si es otro', () => {
    const row = toSaleRow(base, null);
    expect(row.id).toBe('order:7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7f');
    expect(row.buyer.email).toBe('ana@example.com');
    expect(row.buyer.checkoutEmail).toBe('ANA.pago@example.com');
    expect(row.currency).toBe('eur');
    expect(row.coupon).toBe(500);
    expect(row.settlement).toBeNull();
    expect(row.product).toMatchObject({ kind: 'course', ref: 'course:c-1', intervalMonths: null });
  });

  it('cuenta eliminada: sin el correo de la cuenta (queda el del pago) y marcada', () => {
    const row = toSaleRow({ ...base, user_deleted: true }, null);
    expect(row.buyer.deleted).toBe(true);
    expect(row.buyer.email).toBe('ANA.pago@example.com');
  });

  it('cuota de membresía devuelta en origen: «reembolsada entera»', () => {
    const row = toSaleRow(
      {
        ...base,
        kind: 'subscription',
        plan_id: 'p-1',
        plan_name: 'Mensual',
        interval_months: 1,
        origin_refunded: true,
        status: 'refunded',
      },
      null,
    );
    expect(row.id.startsWith('invoice:')).toBe(true);
    expect(row.product).toMatchObject({
      kind: 'membership',
      ref: 'plan:p-1',
      title: 'Mensual',
      intervalMonths: 1,
    });
    expect(row.refundState).toBe('full');
  });

  it('con el reparto de la plataforma: lo pagado en SU moneda y el neto como en «Tus ventas»', () => {
    const row = toSaleRow(
      { ...base, payout_id: 'p-1', presentment_amount: 214977, presentment_currency: 'mxn' },
      {
        id: 'p-1',
        status: 'TRANSFERRED',
        currency: 'eur',
        gross: 10000,
        stripeFee: 175,
        platformFee: 500,
        creatorNet: 9325,
        transferAmount: 9325,
        reinstatedAmount: 0,
        debtNetted: 0,
        refundedAmount: 0,
        refundState: 'none',
      } as never,
    );
    expect(row.amount).toBe(214977);
    expect(row.currency).toBe('mxn');
    expect(row.settlement).toMatchObject({
      currency: 'eur',
      cardFee: 175,
      platformFee: 500,
      net: 9325,
    });
    expect(row.payoutSaleId).toBe('p-1');
  });

  it('la búsqueda escapa los comodines de LIKE', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});
