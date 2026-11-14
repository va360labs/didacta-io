/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * E5 — configuración del portal de cliente POR CREADOR en la cuenta del
 * operador (`PayoutsPortalService`).
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryPlatformStripeClient,
  PayoutsAccountNotFoundError,
  PayoutsPortalService,
} from '../src/index.js';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

let db: FakePayoutsDb;
let fake: InMemoryPlatformStripeClient;
let service: PayoutsPortalService;
let accountA: string;

beforeEach(() => {
  db = new FakePayoutsDb();
  fake = new InMemoryPlatformStripeClient();
  fake.on('POST', '/v1/billing_portal/configurations', (_req, f) => ({
    id: f.nextId('bpc'),
    object: 'billing_portal.configuration',
    livemode: false,
  }));
  accountA = randomUUID();
  db.insert('modPayoutsAccount', {
    id: accountA,
    tenantId: A,
    stripeAccountId: 'acct_1CreadorA',
    status: 'READY',
    portalConfigurationId: null,
    // DEFAULT de la columna: lo que tienen las cuentas de antes de la v2.
    portalConfigVersion: 1,
  });
  service = new PayoutsPortalService(db.port(), fake);
});

describe('PayoutsPortalService.ensureConfiguration', () => {
  it('la primera vez la crea con el nombre de la academia: tarjeta y facturas, SIN baja', async () => {
    const portal = await service.ensureConfiguration(A, { headline: 'Academia de Ana' });
    expect(portal).toEqual({ configurationId: 'bpc_fake_1', onBehalfOf: 'acct_1CreadorA' });
    const [call] = fake.callsTo('POST', '/v1/billing_portal/configurations');
    expect(call!.params).toEqual({
      business_profile: { headline: 'Academia de Ana' },
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        // La baja va por «Darme de baja» del aula (motivo + oferta).
        subscription_cancel: { enabled: false },
      },
      metadata: { didacta_tenant_id: A, didacta_account_id: accountA },
    });
    expect(call!.options.idempotencyKey).toBe(`payouts:portal-config:${accountA}`);
    expect(db.rows('modPayoutsAccount', { id: accountA })[0]).toMatchObject({
      portalConfigurationId: 'bpc_fake_1',
      portalConfigVersion: 2,
    });
    expect(db.rows('modPayoutsObjectRef')).toEqual([
      expect.objectContaining({
        stripeObjectId: 'bpc_fake_1',
        tenantId: A,
        kind: 'portal_configuration',
        source: 'payouts',
      }),
    ]);
  });

  it('después reutiliza la guardada sin llamar a Stripe', async () => {
    await service.ensureConfiguration(A, { headline: 'Academia de Ana' });
    const again = await service.ensureConfiguration(A, { headline: 'Otro nombre' });
    expect(again.configurationId).toBe('bpc_fake_1');
    expect(fake.callsTo('POST', '/v1/billing_portal/configurations')).toHaveLength(1);
  });

  it('dos aperturas a la vez → una configuración (misma clave de idempotencia)', async () => {
    const [one, two] = await Promise.all([
      service.ensureConfiguration(A, { headline: 'Academia de Ana' }),
      service.ensureConfiguration(A, { headline: 'Academia de Ana' }),
    ]);
    expect(one.configurationId).toBe(two.configurationId);
    expect(new Set(fake.calls.map((c) => c.options.idempotencyKey)).size).toBe(1);
  });

  it('academia sin cuenta conectada → PayoutsAccountNotFoundError', async () => {
    await expect(service.ensureConfiguration(B, { headline: 'B' })).rejects.toBeInstanceOf(
      PayoutsAccountNotFoundError,
    );
    expect(fake.calls).toEqual([]);
  });
});

describe('PayoutsPortalService — configuraciones de antes (versión 1, con «cancelar»)', () => {
  beforeEach(() => {
    db.update(
      'modPayoutsAccount',
      { id: accountA },
      {
        portalConfigurationId: 'bpc_vieja',
        portalConfigVersion: 1,
      },
    );
    fake.on('POST', '/v1/billing_portal/configurations/bpc_vieja', () => ({
      id: 'bpc_vieja',
      object: 'billing_portal.configuration',
      livemode: false,
    }));
  });

  it('la primera apertura le quita la baja en Stripe y apunta la versión; después, nada', async () => {
    const portal = await service.ensureConfiguration(A, { headline: 'Academia de Ana' });
    expect(portal.configurationId).toBe('bpc_vieja');
    const [call] = fake.callsTo('POST', '/v1/billing_portal/configurations/bpc_vieja');
    expect(call!.params).toEqual({
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        subscription_cancel: { enabled: false },
      },
    });
    expect(call!.options.idempotencyKey).toBe(`payouts:portal-config:${accountA}:v2`);
    expect(db.rows('modPayoutsAccount', { id: accountA })[0]).toMatchObject({
      portalConfigVersion: 2,
    });
    await service.ensureConfiguration(A, { headline: 'Academia de Ana' });
    expect(fake.callsTo('POST', '/v1/billing_portal/configurations/bpc_vieja')).toHaveLength(1);
    // Nunca crea otra configuración.
    expect(fake.callsTo('POST', '/v1/billing_portal/configurations')).toHaveLength(0);
  });

  it('si Stripe falla, el portal se abre igual y se reintenta la próxima vez', async () => {
    fake.on('POST', '/v1/billing_portal/configurations/bpc_vieja', () => {
      throw new Error('Stripe caído');
    });
    const portal = await service.ensureConfiguration(A, { headline: 'Academia de Ana' });
    expect(portal.configurationId).toBe('bpc_vieja');
    expect(db.rows('modPayoutsAccount', { id: accountA })[0]).toMatchObject({
      portalConfigVersion: 1,
    });
  });
});
