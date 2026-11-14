/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Qué se retira tras el reembolso TOTAL de la compra de un curso
 * (`withdrawRefundedPurchaseAccess`) y que el puente del evento lo use.
 *
 * Origen: venta real del 14-nov-2026 en aula-pruebas. El comprador terminó el
 * curso, se le reembolsó y el registro dijo «reembolso sin matrícula de compra
 * viva (no-op)»: se quedó el curso y el certificado. Contra Postgres de verdad:
 * `tests/integration/refund-access.integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@didacta/core-kernel';
import type { PurchaseAccessRevocation } from '@didacta/mod-learning';
import { BillingRefundBridge } from '../src/modules/billing/billing-refund.bridge';
import {
  withdrawRefundedPurchaseAccess,
  type RefundAccessDeps,
} from '../src/modules/billing/refund-access';

function deps(over: {
  otherOrder?: string | null;
  group?: boolean;
  revoked?: PurchaseAccessRevocation;
  certificates?: number;
}) {
  const revoked: PurchaseAccessRevocation = over.revoked ?? {
    outcome: 'cancelled',
    enrollmentId: 'en-1',
    previousStatus: 'COMPLETED',
  };
  const d = {
    billing: { findOtherLivePurchase: vi.fn().mockResolvedValue(over.otherOrder ?? null) },
    groups: { hasLiveCourseGrant: vi.fn().mockResolvedValue(over.group ?? false) },
    learning: { revokePurchaseAccess: vi.fn().mockResolvedValue(revoked) },
    certificates: { revokeForCourse: vi.fn().mockResolvedValue(over.certificates ?? 1) },
  };
  return d satisfies RefundAccessDeps;
}

const purchase = { tenantId: 't-1', orderId: 'ord-1', userId: 'u-1', courseId: 'c-1' };

describe('withdrawRefundedPurchaseAccess', () => {
  it('curso terminado y reembolsado: cancela la matrícula y revoca su certificado', async () => {
    const d = deps({});
    const result = await withdrawRefundedPurchaseAccess(d, purchase);

    expect(result).toEqual({
      outcome: 'withdrawn',
      enrollmentId: 'en-1',
      previousStatus: 'COMPLETED',
      certificatesRevoked: 1,
    });
    expect(d.billing.findOtherLivePurchase).toHaveBeenCalledWith('t-1', 'u-1', 'c-1', 'ord-1');
    expect(d.learning.revokePurchaseAccess).toHaveBeenCalledWith('t-1', 'u-1', 'c-1', {
      keepAsGroup: false,
    });
    expect(d.certificates.revokeForCourse).toHaveBeenCalledWith('t-1', 'u-1', 'c-1', 'refund');
  });

  it('otra compra cobrada del mismo curso: no se toca ni la matrícula ni el certificado', async () => {
    const d = deps({ otherOrder: 'ord-2' });
    expect(await withdrawRefundedPurchaseAccess(d, purchase)).toEqual({
      outcome: 'other_purchase',
      otherOrderId: 'ord-2',
    });
    expect(d.learning.revokePurchaseAccess).not.toHaveBeenCalled();
    expect(d.certificates.revokeForCourse).not.toHaveBeenCalled();
  });

  it('un grupo (membresía) sigue dando el curso: vuelve a GROUP y el certificado se queda', async () => {
    const d = deps({ group: true, revoked: { outcome: 'kept_by_group', enrollmentId: 'en-1' } });
    expect(await withdrawRefundedPurchaseAccess(d, purchase)).toEqual({
      outcome: 'kept_by_group',
      enrollmentId: 'en-1',
    });
    expect(d.learning.revokePurchaseAccess).toHaveBeenCalledWith('t-1', 'u-1', 'c-1', {
      keepAsGroup: true,
    });
    expect(d.certificates.revokeForCourse).not.toHaveBeenCalled();
  });

  it('matrícula dada a mano (no es de la compra): nada que retirar', async () => {
    const d = deps({ revoked: { outcome: 'none' } });
    expect(await withdrawRefundedPurchaseAccess(d, purchase)).toEqual({
      outcome: 'not_by_purchase',
    });
    expect(d.certificates.revokeForCourse).not.toHaveBeenCalled();
  });

  it('matrícula ya cancelada (reentrega, o pasada a medias): completa la revocación del certificado', async () => {
    const d = deps({
      revoked: { outcome: 'already_cancelled', enrollmentId: 'en-1' },
      certificates: 1,
    });
    expect(await withdrawRefundedPurchaseAccess(d, purchase)).toMatchObject({
      outcome: 'already_withdrawn',
      certificatesRevoked: 1,
    });
  });

  it('orden sin comprador: no consulta nada', async () => {
    const d = deps({});
    expect(await withdrawRefundedPurchaseAccess(d, { ...purchase, userId: null })).toEqual({
      outcome: 'no_buyer',
    });
    expect(d.billing.findOtherLivePurchase).not.toHaveBeenCalled();
  });
});

describe('BillingRefundBridge.revoke', () => {
  it('aplica el criterio con el tenant del evento y registra el resultado', async () => {
    const d = deps({});
    const log = vi.fn();
    const registry = {
      getBillingService: () => d.billing,
      getLearningService: () => d.learning,
      getCertificatesService: () => d.certificates,
    };
    const moduleRef = { get: vi.fn().mockReturnValue(d.groups) };
    const bridge = new BillingRefundBridge(
      registry as never,
      { getEventBus: () => ({ subscribe: () => () => {} }) } as never,
      { log, warn: vi.fn(), error: vi.fn() } as never,
      moduleRef as never,
    );
    const event: DomainEvent<{
      orderId: string;
      productId: string;
      courseId: string;
      userId: string | null;
    }> = {
      name: 'billing.order.refunded',
      version: 1,
      data: { orderId: 'ord-1', productId: 'p-1', courseId: 'c-1', userId: 'u-1' },
      metadata: {
        tenantId: 't-1',
        timestamp: new Date().toISOString(),
        traceId: 'tr',
        idempotencyKey: 'k',
      },
    };

    await bridge.revoke(event);

    expect(d.learning.revokePurchaseAccess).toHaveBeenCalledWith('t-1', 'u-1', 'c-1', {
      keepAsGroup: false,
    });
    expect(d.certificates.revokeForCourse).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'withdrawn', orderId: 'ord-1' }),
      'BillingRefundBridge: acceso retirado tras el reembolso',
    );
  });
});
