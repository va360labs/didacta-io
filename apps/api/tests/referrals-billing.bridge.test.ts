import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@didacta/core-kernel';
import {
  ReferralsBillingBridge,
  type BillingOrderCompletedPayload,
  type BillingOrderRefundedPayload,
} from '../src/modules/referrals/referrals-billing.bridge';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function build(service: Record<string, unknown>) {
  const registry = { getReferralsService: () => service } as never;
  const factory = { getEventBus: () => ({ subscribe: vi.fn() }) } as never;
  return new ReferralsBillingBridge(registry, factory, logger);
}

function completed(data: Partial<BillingOrderCompletedPayload>, tenantId = 't-a') {
  return {
    metadata: { tenantId },
    data: {
      orderId: 'order-1',
      userId: 'buyer-1',
      amountPaid: 4900,
      currency: 'eur',
      ...data,
    },
  } as unknown as DomainEvent<BillingOrderCompletedPayload>;
}

describe('ReferralsBillingBridge', () => {
  it('compra con enlace: llama a recordPurchase con el código normalizado y el tenant del evento', async () => {
    const recordPurchase = vi.fn(async () => ({ accrued: false, reason: 'code_not_found' }));
    const bridge = build({ recordPurchase });
    await bridge.onOrderCompleted(completed({ attribution: { referralCode: ' AbC23xyz ' } }));
    expect(recordPurchase).toHaveBeenCalledWith({
      tenantId: 't-a',
      referralCode: 'abc23xyz',
      buyerUserId: 'buyer-1',
      orderId: 'order-1',
      amountCents: 4900,
      currency: 'eur',
    });
  });

  it('sin enlace, sin comprador o con importe 0 no toca referidos', async () => {
    const recordPurchase = vi.fn();
    const bridge = build({ recordPurchase });
    await bridge.onOrderCompleted(completed({ attribution: null }));
    await bridge.onOrderCompleted(
      completed({ attribution: { referralCode: 'abc' }, userId: null }),
    );
    await bridge.onOrderCompleted(
      completed({ attribution: { referralCode: 'abc' }, amountPaid: 0 }),
    );
    expect(recordPurchase).not.toHaveBeenCalled();
  });

  it('un fallo de referidos no rompe la compra (no lanza)', async () => {
    const bridge = build({
      recordPurchase: vi.fn(async () => {
        throw new Error('db caída');
      }),
    });
    await expect(
      bridge.onOrderCompleted(completed({ attribution: { referralCode: 'abc23xyz' } })),
    ).resolves.toBeUndefined();
  });

  it('reembolso: anula la comisión por la referencia de la orden', async () => {
    const revokeCommissionByInvoice = vi.fn(async () => ({ revoked: true, commissionId: 'c1' }));
    const bridge = build({ revokeCommissionByInvoice });
    await bridge.onOrderRefunded({
      metadata: { tenantId: 't-a' },
      data: { orderId: 'order-9' },
    } as unknown as DomainEvent<BillingOrderRefundedPayload>);
    expect(revokeCommissionByInvoice).toHaveBeenCalledWith(
      't-a',
      'order:order-9',
      'Reembolso de la compra en Stripe',
    );
  });
});
