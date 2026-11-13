import { stripe, log, loadState, saveState } from './lib.mjs';
const s = loadState();
const meta = { creado_por: 'auditoria-comision-2026-11-12' };
const caps = { card_payments: { requested: true }, transfers: { requested: true } };
const tries = {
  express_perdidas_plataforma: {
    country: 'ES',
    email: 'creador-express+auditoria@example.com',
    controller: {
      losses: { payments: 'application' },
      fees: { payer: 'application' },
      stripe_dashboard: { type: 'express' },
      requirement_collection: 'stripe',
    },
    capabilities: caps,
    metadata: meta,
  },
  express_perdidas_stripe: {
    country: 'ES',
    email: 'creador-express2+auditoria@example.com',
    controller: {
      losses: { payments: 'stripe' },
      fees: { payer: 'application' },
      stripe_dashboard: { type: 'express' },
      requirement_collection: 'stripe',
    },
    capabilities: caps,
    metadata: meta,
  },
};
for (const [k, params] of Object.entries(tries)) {
  if (s[k]) continue;
  const a = await stripe('POST', '/v1/accounts', params, { soft: true });
  log(
    k,
    a.__error
      ? { error: a.__error.message }
      : { id: a.id, type: a.type, controller: a.controller, capabilities: a.capabilities },
  );
  if (!a.__error) s[k] = a.id;
}
saveState(s);
