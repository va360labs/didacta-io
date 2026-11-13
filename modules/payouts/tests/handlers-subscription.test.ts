/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * E5 — atribución de los eventos de una suscripción cobrada por la plataforma:
 * los hijos de la sesión (`sub_…`, `cus_…`) se atan a ella leyendo la sesión de
 * la API, y un `invoice.paid` que llega ANTES que el `checkout.session.completed`
 * se atribuye preguntando a Stripe por la sesión de origen.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePlatformEventTenant, routePlatformEvent } from '../src/event-router.js';
import { registerSubscriptionChildren } from '../src/handlers/subscription.js';
import { InMemoryPlatformStripeClient, RefsService, type ObjectRef } from '../src/index.js';
import facturas from './fixtures/invoices-2026-11-12.json';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';

const A = '11111111-1111-4111-8111-111111111111';
const PLAN = '33333333-3333-4333-8333-333333333333';

let db: FakePayoutsDb;
let fake: InMemoryPlatformStripeClient;

/** La sesión real de una suscripción del sandbox, tal y como la devuelve la API. */
const REAL_SESSION = facturas.checkout_session_de_suscripcion as Record<string, unknown>;
const SESSION_ID = REAL_SESSION['id'] as string;
const SUB_ID = REAL_SESSION['subscription'] as string;
const CUS_ID = REAL_SESSION['customer'] as string;

function sessionRef(over: Partial<ObjectRef> = {}): ObjectRef {
  return {
    stripeObjectId: SESSION_ID,
    tenantId: A,
    kind: 'checkout_session',
    source: 'membership',
    localRef: PLAN,
    parentObjectId: null,
    livemode: false,
    createdAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  db = new FakePayoutsDb();
  fake = new InMemoryPlatformStripeClient();
  fake.seed(structuredClone(REAL_SESSION));
});

describe('registerSubscriptionChildren', () => {
  it('ata sub_ y cus_ a la sesión, leyéndolos de la API; una reentrega no duplica', async () => {
    db.insert('modPayoutsObjectRef', { ...sessionRef() });
    const first = await registerSubscriptionChildren(
      { db: db.port(), stripe: fake },
      { tenantId: A, sessionRef: sessionRef() },
    );
    expect(first).toEqual({
      outcome: 'registered',
      subscriptionId: SUB_ID,
      customerId: CUS_ID,
      created: 2,
    });
    expect(
      db
        .rows('modPayoutsObjectRef', { parentObjectId: SESSION_ID })
        .map((r) => [r['stripeObjectId'], r['kind'], r['source'], r['localRef'], r['tenantId']]),
    ).toEqual([
      [SUB_ID, 'subscription', 'membership', PLAN, A],
      [CUS_ID, 'customer', 'membership', PLAN, A],
    ]);
    expect(fake.calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', `/v1/checkout/sessions/${SESSION_ID}`],
    ]);

    const again = await registerSubscriptionChildren(
      { db: db.port(), stripe: fake },
      { tenantId: A, sessionRef: sessionRef() },
    );
    expect(again).toMatchObject({ outcome: 'registered', created: 0 });
    expect(db.rows('modPayoutsObjectRef')).toHaveLength(3);
  });

  it('una sesión de compra de curso (billing) o de otro tenant no registra nada', async () => {
    for (const ref of [sessionRef({ source: 'billing' }), sessionRef({ tenantId: 'otro' })]) {
      expect(
        await registerSubscriptionChildren(
          { db: db.port(), stripe: fake },
          { tenantId: A, sessionRef: ref },
        ),
      ).toEqual({ outcome: 'no_subscription' });
    }
    expect(fake.calls).toEqual([]);
    expect(db.rows('modPayoutsObjectRef')).toEqual([]);
  });

  it('una sesión en modo pago (aunque el registro diga membresía) no registra nada', async () => {
    fake.patch(SESSION_ID, { mode: 'payment', subscription: null });
    expect(
      await registerSubscriptionChildren(
        { db: db.port(), stripe: fake },
        { tenantId: A, sessionRef: sessionRef() },
      ),
    ).toEqual({ outcome: 'no_subscription' });
  });
});

describe('invoice.paid antes que checkout.session.completed', () => {
  function sessionsBySubscription() {
    fake.on('GET', '/v1/checkout/sessions', (req) => ({
      object: 'list',
      data: req.params['subscription'] === SUB_ID ? [{ id: SESSION_ID }] : [],
      has_more: false,
    }));
  }

  it('forma nueva (sin PaymentIntent): se pregunta a Stripe por la sesión de la suscripción', async () => {
    db.insert('modPayoutsObjectRef', { ...sessionRef() });
    sessionsBySubscription();
    const invoice = {
      ...(facturas.formaB_invoice_endive_expand_payments as Record<string, unknown>),
      parent: { type: 'subscription_details', subscription_details: { subscription: SUB_ID } },
      customer: CUS_ID,
    };
    const route = routePlatformEvent({
      id: 'evt_1',
      type: 'invoice.paid',
      livemode: false,
      data: { object: invoice },
    } as never);
    if (route.kind !== 'objects') throw new Error('ruta inesperada');
    expect(route.subscriptionId).toBe(SUB_ID);
    const refs = new RefsService(db.client(null) as never);
    const attribution = await resolvePlatformEventTenant(route, { refs, stripe: fake });
    expect(attribution).toMatchObject({ status: 'resolved', tenantId: A, via: 'origin_session' });
  });

  it('forma anterior a basil (PaymentIntent en la raíz): si por el PaymentIntent no hay sesión, por la suscripción', async () => {
    db.insert('modPayoutsObjectRef', { ...sessionRef() });
    sessionsBySubscription();
    const invoice = {
      ...(facturas.formaA_invoice_acacia as Record<string, unknown>),
      subscription: SUB_ID,
      customer: CUS_ID,
    };
    const route = routePlatformEvent({
      id: 'evt_2',
      type: 'invoice.paid',
      livemode: false,
      data: { object: invoice },
    } as never);
    if (route.kind !== 'objects') throw new Error('ruta inesperada');
    const refs = new RefsService(db.client(null) as never);
    const attribution = await resolvePlatformEventTenant(route, { refs, stripe: fake });
    expect(attribution).toMatchObject({ status: 'resolved', tenantId: A, via: 'origin_session' });
    expect(
      fake.callsTo('GET', '/v1/checkout/sessions').map((c) => Object.keys(c.params)[0]),
    ).toEqual(['payment_intent', 'subscription']);
  });

  it('sin sesión de origen registrada → sin atribuir (la metadata no decide)', async () => {
    sessionsBySubscription();
    const route = routePlatformEvent({
      id: 'evt_3',
      type: 'invoice.paid',
      livemode: false,
      data: {
        object: {
          id: 'in_x',
          parent: { subscription_details: { subscription: SUB_ID, metadata: { tenantId: A } } },
        },
      },
    } as never);
    if (route.kind !== 'objects') throw new Error('ruta inesperada');
    const refs = new RefsService(db.client(null) as never);
    expect(await resolvePlatformEventTenant(route, { refs, stripe: fake })).toEqual({
      status: 'unknown',
    });
  });
});
