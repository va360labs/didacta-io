import { stripe, log, loadState, saveState } from './lib.mjs';
const s = loadState();
const meta = { creado_por: 'auditoria-comision-2026-11-12' };
const caps = { card_payments: { requested: true }, transfers: { requested: true } };
const tries = {
  dest_stripe_riesgo_sin_panel: {
    country: 'ES',
    email: 'creador-dest+auditoria@example.com',
    controller: {
      losses: { payments: 'stripe' },
      fees: { payer: 'application' },
      stripe_dashboard: { type: 'none' },
      requirement_collection: 'stripe',
    },
    capabilities: caps,
    metadata: meta,
  },
  dest_stripe_riesgo_panel_full: {
    country: 'ES',
    email: 'creador-dest2+auditoria@example.com',
    controller: {
      losses: { payments: 'stripe' },
      fees: { payer: 'application' },
      stripe_dashboard: { type: 'full' },
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
