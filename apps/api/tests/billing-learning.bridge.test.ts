import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@didacta/core-kernel';
import { AlreadyEnrolledError } from '@didacta/mod-learning';
import { BillingLearningBridge } from '../src/modules/billing/billing-learning.bridge';

interface BillingOrderCompletedPayload {
  orderId: string;
  productId: string;
  courseId: string;
  userId: string;
  amountPaid: number | null;
  currency: string;
  customerEmail: string | null;
}

const event = (
  overrides: Partial<BillingOrderCompletedPayload> = {},
): DomainEvent<BillingOrderCompletedPayload> => ({
  name: 'billing.order.completed',
  version: 1,
  data: {
    orderId: 'ord-1',
    productId: 'prd-1',
    courseId: 'course-1',
    userId: 'user-1',
    amountPaid: 9900,
    currency: 'eur',
    customerEmail: 'alumno@example.com',
    ...overrides,
  },
  metadata: {
    tenantId: 'tenant-1',
    timestamp: new Date().toISOString(),
    traceId: 'trace-1',
    idempotencyKey: 'idem-1',
  },
});

const noopLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

function makeRegistry(enrollFromPurchase: ReturnType<typeof vi.fn>) {
  return {
    getLearningService: () => ({ enrollFromPurchase }),
  } as never;
}

const noopFactory = {
  getEventBus: () => ({ subscribe: () => () => {} }),
} as never;

describe('BillingLearningBridge.enroll', () => {
  it('llama a enrollFromPurchase con (tenantId, userId, courseId) tras pago', async () => {
    const enrollFromPurchase = vi.fn().mockResolvedValue({});
    const bridge = new BillingLearningBridge(
      makeRegistry(enrollFromPurchase),
      noopFactory,
      noopLogger,
    );

    await bridge.enroll(event());

    expect(enrollFromPurchase).toHaveBeenCalledTimes(1);
    expect(enrollFromPurchase).toHaveBeenCalledWith('tenant-1', 'user-1', 'course-1');
  });

  it('respeta el tenantId del metadata del evento (no del data)', async () => {
    const enrollFromPurchase = vi.fn().mockResolvedValue({});
    const bridge = new BillingLearningBridge(
      makeRegistry(enrollFromPurchase),
      noopFactory,
      noopLogger,
    );

    const e = event();
    e.metadata.tenantId = 'tenant-otro';
    await bridge.enroll(e);

    expect(enrollFromPurchase).toHaveBeenCalledWith('tenant-otro', 'user-1', 'course-1');
  });

  it('idempotente: AlreadyEnrolledError se captura como no-op (webhook duplicado)', async () => {
    const enrollFromPurchase = vi.fn().mockRejectedValue(new AlreadyEnrolledError());
    const bridge = new BillingLearningBridge(
      makeRegistry(enrollFromPurchase),
      noopFactory,
      noopLogger,
    );

    await expect(bridge.enroll(event())).resolves.toBeUndefined();
    expect(enrollFromPurchase).toHaveBeenCalledTimes(1);
  });

  it('rethrows cualquier otro error para que el outbox reintente', async () => {
    const enrollFromPurchase = vi.fn().mockRejectedValue(new Error('db down'));
    const bridge = new BillingLearningBridge(
      makeRegistry(enrollFromPurchase),
      noopFactory,
      noopLogger,
    );

    await expect(bridge.enroll(event())).rejects.toThrow('db down');
  });

  it('logea contexto completo (tenantId, userId, courseId, orderId) tras éxito', async () => {
    const log = vi.fn();
    const logger = { ...noopLogger, log } as never;
    const enrollFromPurchase = vi.fn().mockResolvedValue({});
    const bridge = new BillingLearningBridge(makeRegistry(enrollFromPurchase), noopFactory, logger);

    await bridge.enroll(event({ orderId: 'ord-99' }));

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        courseId: 'course-1',
        orderId: 'ord-99',
      }),
      expect.stringContaining('enrolled after purchase'),
    );
  });
});

describe('BillingLearningBridge.onModuleInit', () => {
  it('se suscribe a billing.order.completed exactamente una vez', () => {
    const subscribe = vi.fn().mockReturnValue(() => {});
    const factory = { getEventBus: () => ({ subscribe }) } as never;
    const bridge = new BillingLearningBridge(makeRegistry(vi.fn()), factory, noopLogger);

    bridge.onModuleInit();

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith('billing.order.completed', expect.any(Function));
  });
});
