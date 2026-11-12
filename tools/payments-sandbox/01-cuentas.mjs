import { stripe, log, loadState, saveState } from './lib.mjs';
const s = loadState();
const meta = { creado_por: 'verificacion-diseno-pagos-2026-11-12' };
const PREVIEW = '2026-10-28.preview';

const plat = await stripe('GET', '/v1/account');
log('plataforma', { id: plat.id, country: plat.country, default_currency: plat.default_currency });
const bal = await stripe('GET', '/v1/balance');
log('saldo plataforma', {
  available: bal.available,
  pending: bal.pending,
  connect_reserved: bal.connect_reserved,
});

const caps = { card_payments: { requested: true }, transfers: { requested: true } };
// Matriz v1 controller: dashboard x fees.payer x losses
const matriz = {
  v1_express_app_app: {
    controller: {
      stripe_dashboard: { type: 'express' },
      fees: { payer: 'application' },
      losses: { payments: 'application' },
      requirement_collection: 'stripe',
    },
    capabilities: caps,
  },
  v1_express_app_stripe: {
    controller: {
      stripe_dashboard: { type: 'express' },
      fees: { payer: 'application' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    },
    capabilities: caps,
  },
  v1_express_account_stripe: {
    controller: {
      stripe_dashboard: { type: 'express' },
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    },
    capabilities: caps,
  },
  v1_none_app_app_custom: {
    controller: {
      stripe_dashboard: { type: 'none' },
      fees: { payer: 'application' },
      losses: { payments: 'application' },
      requirement_collection: 'application',
    },
    capabilities: caps,
  },
  v1_none_app_stripe: {
    controller: {
      stripe_dashboard: { type: 'none' },
      fees: { payer: 'application' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    },
    capabilities: caps,
  },
  v1_type_express: { type: 'express', capabilities: caps },
  v1_type_custom: { type: 'custom', capabilities: caps },
};
for (const [k, p] of Object.entries(matriz)) {
  for (const ver of [undefined, PREVIEW]) {
    const key = k + (ver ? '_preview' : '');
    if (s[key]) {
      log(key, { ya: s[key] });
      continue;
    }
    const a = await stripe(
      'POST',
      '/v1/accounts',
      { country: 'ES', email: `creador-${key}@example.com`, metadata: meta, ...p },
      { soft: true, version: ver },
    );
    log(
      key,
      a.__error
        ? { error: a.__error.message, code: a.__error.code }
        : { id: a.id, type: a.type, controller: a.controller, caps: a.capabilities },
    );
    if (!a.__error) s[key] = a.id;
    if (!a.__error) break; // con una basta
  }
}
saveState(s);
