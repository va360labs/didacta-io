/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * «Tus ventas», su resumen y el disparo manual del conciliador, sin base de
 * datos: quién puede llamar y de qué aula se leen. El aislamiento con RLS
 * real está en `tests/integration/payouts-settlement.integration.test.ts`.
 */

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { SessionClaims } from '../src/auth/token.service';
import {
  PayoutsSalesController,
  reconcileRunSchema,
  refundPreviewQuerySchema,
  refundSchema,
  salesQuerySchema,
} from '../src/modules/payouts/payouts-sales.controller';
import { tenantContextStorage } from '../src/tenancy/tenant-context.storage';

const currentTenantId = () => tenantContextStorage.getStore()?.tenantId;

const A = '11111111-1111-4111-8111-111111111111';

function claims(roles: string[], extra: Partial<SessionClaims> = {}): SessionClaims {
  return { sub: 'user-1', tenantId: A, roles, ...extra } as SessionClaims;
}

function build() {
  const seen: Array<{ op: string; tenantId: string; contextTenant: string | null }> = [];
  const runtime = {
    config: { displayName: 'Didacta' },
    reports: {
      listSales: vi.fn(async (tenantId: string, options: unknown) => {
        seen.push({ op: 'sales', tenantId, contextTenant: currentTenantId() ?? null });
        return { items: [], page: (options as { page: number }).page, pageSize: 20, total: 0 };
      }),
      summary: vi.fn(async (tenantId: string) => {
        seen.push({ op: 'summary', tenantId, contextTenant: currentTenantId() ?? null });
        return { currencies: [], awaitingFeeCount: 0 };
      }),
    },
    settings: { get: vi.fn(async () => ({ tenantId: A, feeBps: 500, updatedAt: null })) },
    refunds: {
      preview: vi.fn(async (tenantId: string, saleId: string, amount?: number) => {
        seen.push({ op: 'preview', tenantId, contextTenant: currentTenantId() ?? null });
        return { saleId, amount: amount ?? 10000 };
      }),
      refund: vi.fn(async (input: { tenantId: string; saleId: string; amount?: number }) => {
        seen.push({
          op: 'refund',
          tenantId: input.tenantId,
          contextTenant: currentTenantId() ?? null,
        });
        return {
          refundId: 'r-1',
          saleId: input.saleId,
          stripeRefundId: 're_1',
          amount: input.amount ?? 10000,
          currency: 'eur',
          status: 'succeeded',
          accounting: 'accounted',
        };
      }),
    },
  };
  const reconcile = { run: vi.fn(async (options: unknown) => ({ ok: true, options })) };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new PayoutsSalesController(
    runtime as never,
    reconcile as never,
    audit as never,
  );
  return { controller, runtime, reconcile, seen, audit };
}

const SALE = '44444444-4444-4444-8444-444444444444';
const REQ = { headers: {}, ip: '127.0.0.1' } as never;

describe('Reembolsar (E6)', () => {
  it('el aula sale del token, corre con su contexto, y queda en la auditoría', async () => {
    const { controller, runtime, seen, audit } = build();
    const result = await controller.refund(REQ, claims(['tenant_admin']), SALE, { amount: 4000 });
    expect(result).toMatchObject({ refundId: 'r-1', amount: 4000 });
    expect(runtime.refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: A, saleId: SALE, amount: 4000, initiatedBy: 'user-1' }),
    );
    expect(seen).toEqual([{ op: 'refund', tenantId: A, contextTenant: A }]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: A,
        action: 'payouts.sale.refunded',
        resourceId: SALE,
        metadata: expect.objectContaining({ refundId: 'r-1', stripeRefundId: 're_1' }),
      }),
    );
    await controller.refundPreview(claims(['tenant_admin']), SALE, { amount: 4000 });
    expect(runtime.refunds.preview).toHaveBeenCalledWith(A, SALE, 4000);
  });

  it('sin sesión → 401; un alumno → 403; una sesión de soporte no reembolsa', async () => {
    const { controller, runtime } = build();
    await expect(controller.refund(REQ, undefined, SALE, {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.refund(REQ, claims(['student']), SALE, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      controller.refund(REQ, claims(['tenant_admin'], { sup: true } as never), SALE, {}),
    ).rejects.toMatchObject({ response: { code: 'PAYOUTS_SUPPORT_SESSION_FORBIDDEN' } });
    expect(runtime.refunds.refund).not.toHaveBeenCalled();
  });

  it('el cuerpo se valida: importe entero > 0 y requestId UUID', () => {
    expect(refundSchema.parse(undefined)).toEqual({});
    expect(refundSchema.parse({ amount: '4000' })).toEqual({ amount: 4000 });
    expect(() => refundSchema.parse({ amount: 0 })).toThrow();
    expect(() => refundSchema.parse({ amount: 12.5 })).toThrow();
    expect(() => refundSchema.parse({ requestId: 'no-es-uuid' })).toThrow();
    expect(refundPreviewQuerySchema.parse({ amount: '250' })).toEqual({ amount: 250 });
  });
});

describe('GET sales / summary', () => {
  it('el aula sale del token y la consulta corre con su contexto (RLS)', async () => {
    const { controller, seen } = build();
    await controller.sales(claims(['tenant_admin']), { page: 2, pageSize: 20 });
    const summary = await controller.summary(claims(['tenant_admin']));
    expect(seen).toEqual([
      { op: 'sales', tenantId: A, contextTenant: A },
      { op: 'summary', tenantId: A, contextTenant: A },
    ]);
    expect(summary).toEqual({
      currencies: [],
      awaitingFeeCount: 0,
      operatorName: 'Didacta',
      feeBps: 500,
    });
  });

  it('sin sesión → 401; un alumno → 403', async () => {
    const { controller, runtime } = build();
    await expect(controller.sales(undefined, { page: 1, pageSize: 20 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.summary(claims(['student']))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(runtime.reports.listSales).not.toHaveBeenCalled();
    expect(runtime.reports.summary).not.toHaveBeenCalled();
  });

  it('la paginación se valida: página ≥ 1, tamaño 1–100', () => {
    expect(salesQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(salesQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
    expect(salesQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(salesQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });
});

describe('POST admin/reconcile/run-now', () => {
  it('solo super_admin, y nunca una sesión de soporte', async () => {
    const { controller, reconcile } = build();
    await expect(
      controller.runNow(claims(['tenant_admin']), { deep: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.runNow(claims(['super_admin'], { sup: 'grant-1' }), { deep: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(reconcile.run).not.toHaveBeenCalled();
    await expect(controller.runNow(claims(['super_admin']), { deep: true })).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    expect(reconcile.run).toHaveBeenCalledWith({ deep: true, windowHours: undefined });
  });

  it('el cuerpo es opcional: por defecto, pasada horaria', () => {
    expect(reconcileRunSchema.parse(undefined)).toEqual({ deep: false });
    expect(reconcileRunSchema.safeParse({ windowHours: 0 }).success).toBe(false);
  });
});
