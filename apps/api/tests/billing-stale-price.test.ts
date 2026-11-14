/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Sesiones de pago con un precio viejo (venta real del 14-nov-2026: la página
 * de venta abierta enseñaba 29 € y se cobró 1 €; una sesión de 29 € quedó
 * abierta 24 h después de bajar el precio).
 *
 *  - El filtro devuelve 409 BILLING_PRICE_CHANGED con el precio de ahora, para
 *    que la pantalla lo enseñe sin otra llamada.
 *  - Archivar el curso caduca sus sesiones abiertas.
 *
 * Lo demás (caducar al cambiar el precio, retirar o borrar la opción, la
 * comprobación en `startCheckout`) está en `modules/billing/tests`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@didacta/core-kernel';
import { PriceChangedError } from '@didacta/mod-billing';
import { BillingErrorFilter } from '../src/modules/billing/billing-error.filter';
import { BillingCourseArchivedBridge } from '../src/modules/billing/billing-course-archived.bridge';

function capture(error: unknown) {
  const captured: { status?: number; body?: Record<string, unknown> } = {};
  const reply = {
    status(s: number) {
      captured.status = s;
      return this;
    },
    send(b: Record<string, unknown>) {
      captured.body = b;
      return this;
    },
  };
  new BillingErrorFilter().catch(
    error as never,
    {
      getType: () => 'http',
      switchToHttp: () => ({ getResponse: () => reply }),
    } as never,
  );
  return captured;
}

describe('BillingErrorFilter — el precio cambió con la página abierta', () => {
  it('409 BILLING_PRICE_CHANGED con el precio de ahora en el cuerpo', () => {
    const { status, body } = capture(
      new PriceChangedError({ unitAmount: 100, currency: 'eur' }, 'curso-1'),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'BILLING_PRICE_CHANGED',
      currentPrice: { unitAmount: 100, currency: 'eur' },
    });
  });
});

describe('BillingCourseArchivedBridge', () => {
  function bridge(expireOpenCheckouts: ReturnType<typeof vi.fn>) {
    const subscribe = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const b = new BillingCourseArchivedBridge(
      { getBillingService: () => ({ expireOpenCheckouts }) } as never,
      { getEventBus: () => ({ subscribe }) } as never,
      logger as never,
    );
    return { b, subscribe, logger };
  }

  const event: DomainEvent<{ courseId: string }> = {
    name: 'courses.course.archived',
    version: 1,
    data: { courseId: 'curso-1' },
    metadata: {
      tenantId: 't-1',
      timestamp: new Date().toISOString(),
      traceId: 't',
      idempotencyKey: 'k',
    },
  };

  it('se suscribe a courses.course.archived', () => {
    const { b, subscribe } = bridge(vi.fn());
    b.onModuleInit();
    expect(subscribe).toHaveBeenCalledWith('courses.course.archived', expect.any(Function));
  });

  it('archivar el curso caduca sus sesiones abiertas, con el tenant del evento', async () => {
    const expire = vi
      .fn()
      .mockResolvedValue({ expired: 1, cancelledOrders: 1, alreadyPaid: 0, failed: 0 });
    const { b, logger } = bridge(expire);
    await b.expire(event);
    expect(expire).toHaveBeenCalledWith('t-1', { courseId: 'curso-1' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('si alguna no se pudo caducar, deja aviso (no se calla)', async () => {
    const expire = vi
      .fn()
      .mockResolvedValue({ expired: 0, cancelledOrders: 0, alreadyPaid: 0, failed: 1 });
    const { b, logger } = bridge(expire);
    await b.expire(event);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failed: 1, courseId: 'curso-1' }),
      expect.stringContaining('no se pudieron caducar'),
    );
  });
});
