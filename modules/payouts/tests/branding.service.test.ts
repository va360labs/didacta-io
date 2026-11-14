/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * La marca del aula en su cuenta conectada: qué se manda a Stripe, cuándo NO
 * se manda nada (misma huella) y qué pasa si Stripe rechaza el descriptor.
 */

import { describe, expect, it } from 'vitest';
import type { PayoutsDbPort, PayoutsTx } from '../src/accounts.service.js';
import {
  BRANDING_METADATA_KEY,
  PayoutsBrandingService,
  prepareBranding,
  type PayoutsBrandInput,
} from '../src/branding.service.js';
import {
  brandingParams,
  createConnectedAccountsApi,
  sanitizeStatementDescriptorPrefix,
} from '../src/stripe/accounts-api.js';
import { encodeStripeForm, type StripeObject } from '../src/stripe/platform-stripe.client.js';
import { InMemoryPlatformStripeClient } from '../src/stripe/platform-stripe.fake.js';

const ACCT = 'acct_1PrimerSorbo01';
const TENANT = 'tenant-primer-sorbo';

function dbWith(accountId: string | null): PayoutsDbPort {
  const tx = {
    modPayoutsAccount: {
      findFirst: async () => (accountId === null ? null : { stripeAccountId: accountId }),
    },
  } as unknown as PayoutsTx;
  return {
    inTenant: async (_tenantId, fn) => fn(tx),
    global: async (fn) => fn(tx),
  };
}

function world(accountId: string | null = ACCT) {
  const stripe = new InMemoryPlatformStripeClient();
  stripe.seed({ id: ACCT, object: 'account', metadata: {}, settings: {} });
  stripe.on('POST', '/v1/accounts/:id', (req, fake) => {
    const current = fake.get(req.pathParams['id']!) ?? {};
    const metadata = {
      ...((current['metadata'] as Record<string, string>) ?? {}),
      ...((req.params['metadata'] as Record<string, string>) ?? {}),
    };
    fake.patch(req.pathParams['id']!, { metadata, settings: req.params['settings'] ?? {} });
    return fake.get(req.pathParams['id']!) as StripeObject;
  });
  const api = createConnectedAccountsApi(stripe, 'v2');
  const service = new PayoutsBrandingService(dbWith(accountId), api);
  return { stripe, service };
}

const PNG = {
  bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
  contentType: 'image/png' as const,
};

const BRAND: PayoutsBrandInput = {
  name: 'Primer Sorbo',
  primaryColor: '#E2703A',
  secondaryColor: '#e2703a',
  icon: PNG,
  logo: null,
};

describe('sanitizeStatementDescriptorPrefix', () => {
  it('2–10 caracteres latinos, cortando por palabra cuando cabe', () => {
    expect(sanitizeStatementDescriptorPrefix('Primer Sorbo')).toBe('PRIMER');
    expect(sanitizeStatementDescriptorPrefix('Café')).toBe('CAFE');
    expect(sanitizeStatementDescriptorPrefix('Academiadelcafé Online')).toBe('ACADEMIADE');
    expect(sanitizeStatementDescriptorPrefix('Ñu')).toBe('NU');
    expect(sanitizeStatementDescriptorPrefix('"*<>')).toBeNull();
    expect(sanitizeStatementDescriptorPrefix('7')).toBeNull();
    expect(sanitizeStatementDescriptorPrefix(null)).toBeNull();
  });
});

describe('brandingParams', () => {
  it('cadena vacía = quitar la imagen; null = no tocar', () => {
    const pairs = encodeStripeForm(
      brandingParams({ iconFileId: '', logoFileId: null, primaryColor: '#112233' }),
    );
    expect(pairs).toEqual([
      ['settings[branding][icon]', ''],
      ['settings[branding][primary_color]', '#112233'],
    ]);
  });
});

describe('PayoutsBrandingService.sync', () => {
  it('sube el icono y aplica color, descriptor, prefijo y la huella', async () => {
    const { stripe, service } = world();
    const result = await service.sync(TENANT, BRAND);
    expect(result).toMatchObject({ applied: true, changed: true });
    expect(stripe.files).toEqual([
      expect.objectContaining({ purpose: 'business_icon', filename: 'icono.png', bytes: 7 }),
    ]);
    const update = stripe.calls.find(
      (c) => c.method === 'POST' && c.path === `/v1/accounts/${ACCT}`,
    )!;
    expect(update.params).toEqual({
      business_profile: { name: 'Primer Sorbo' },
      settings: {
        branding: {
          icon: stripe.files[0]!.id,
          // Sin logo con nombre no se manda (Stripe pinta el nombre). Nunca la
          // cadena vacía: Stripe no deja quitar un logo y rechazaría todo.
          primary_color: '#e2703a',
          secondary_color: '#e2703a',
        },
        payments: { statement_descriptor: 'PRIMER SORBO' },
        card_payments: { statement_descriptor_prefix: 'PRIMER' },
      },
      metadata: { [BRANDING_METADATA_KEY]: prepareBranding(BRAND).fingerprint },
    });
  });

  it('con la misma marca no sube ni escribe nada', async () => {
    const { stripe, service } = world();
    await service.sync(TENANT, BRAND);
    const before = stripe.calls.length;
    const again = await service.sync(TENANT, { ...BRAND, primaryColor: '#e2703a' });
    expect(again).toMatchObject({ applied: true, changed: false });
    // Solo la lectura de la cuenta.
    expect(stripe.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v1/accounts/${ACCT}`,
    ]);
  });

  it('si cambia el color, se vuelve a aplicar', async () => {
    const { stripe, service } = world();
    await service.sync(TENANT, BRAND);
    const again = await service.sync(TENANT, { ...BRAND, primaryColor: '#1e5aa8' });
    expect(again).toMatchObject({ applied: true, changed: true });
    expect(stripe.files).toHaveLength(2);
  });

  it('logo con el nombre dentro (modo «solo logo»): va también como logo', async () => {
    const { stripe, service } = world();
    await service.sync(TENANT, { ...BRAND, logo: { ...PNG, contentType: 'image/jpeg' } });
    expect(stripe.files.map((f) => f.purpose)).toEqual(['business_icon', 'business_logo']);
    expect(stripe.files[1]!.filename).toBe('logo.jpg');
  });

  it('si Stripe rechaza el descriptor, la marca se aplica sin él', async () => {
    const { stripe, service } = world();
    stripe.failNext(`/v1/accounts/${ACCT}`, {
      method: 'POST',
      message: 'The statement descriptor must be similar to your business name.',
      param: 'settings[payments][statement_descriptor]',
    });
    const result = await service.sync(TENANT, BRAND);
    expect(result).toMatchObject({ applied: true, changed: true });
    const posts = stripe.calls.filter(
      (c) => c.method === 'POST' && c.path.startsWith('/v1/accounts/'),
    );
    expect(posts).toHaveLength(2);
    const settings = posts[1]!.params['settings'] as Record<string, unknown>;
    expect(settings).not.toHaveProperty('payments');
    expect(settings).not.toHaveProperty('card_payments');
    expect(posts[1]!.params).not.toHaveProperty('business_profile');
    expect(settings['branding']).toBeDefined();
  });

  it('nunca lanza: sin cuenta, o con Stripe caído, devuelve applied: false', async () => {
    const sinCuenta = world(null);
    await expect(sinCuenta.service.sync(TENANT, BRAND)).resolves.toEqual({
      applied: false,
      reason: 'no_account',
    });
    const caido = world();
    caido.stripe.failNext(`/v1/accounts/${ACCT}`, { method: 'GET', message: 'boom', status: 500 });
    await expect(caido.service.sync(TENANT, BRAND)).resolves.toMatchObject({ applied: false });
  });

  it('un nombre que no da para descriptor no manda descriptor', () => {
    const prepared = prepareBranding({ ...BRAND, name: 'Té' });
    expect(prepared.statementDescriptor).toBeNull();
    expect(prepared.statementDescriptorPrefix).toBe('TE');
  });
});
