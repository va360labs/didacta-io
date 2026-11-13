import { stripe, v2, log, loadState, saveState, PREVIEW } from './lib2.mjs';
const s = loadState();
const meta = { creado_por: 'verificacion-diseno-pagos-2026-11-12' };
const mk = (country, currency, dashboard, fees, losses, cfg = 'ambas') => ({
  contact_email: `creador-v2-${country}-${dashboard}-${fees}-${losses}@example.com`,
  display_name: `Academia de prueba ${country.toUpperCase()}`,
  dashboard,
  identity: { country, entity_type: 'individual' },
  configuration: {
    ...(cfg !== 'solo_recipient'
      ? { merchant: { capabilities: { card_payments: { requested: true } } } }
      : {}),
    recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
  },
  defaults: { currency, responsibilities: { fees_collector: fees, losses_collector: losses } },
  metadata: meta,
  include: [
    'configuration.merchant',
    'configuration.recipient',
    'identity',
    'defaults',
    'requirements',
  ],
});
const resumen = (a) =>
  a.__error
    ? {
        error: a.__error.message ?? JSON.stringify(a.__error),
        code: a.__error.code,
        status: a.status,
      }
    : {
        id: a.id,
        dashboard: a.dashboard,
        resp: a.defaults?.responsibilities,
        applied: a.applied_configurations,
        merchant_caps:
          a.configuration?.merchant?.capabilities &&
          Object.fromEntries(
            Object.entries(a.configuration.merchant.capabilities)
              .filter(([, v]) => v)
              .map(([k, v]) => [k, v.status ?? v]),
          ),
        recipient_caps: JSON.stringify(a.configuration?.recipient?.capabilities),
      };

// A) Matriz de responsabilidades en ES con panel express
for (const [fees, losses] of [
  ['application', 'application'],
  ['application', 'stripe'],
  ['stripe', 'stripe'],
  ['stripe', 'application'],
]) {
  for (const dash of ['express', 'none']) {
    const k = `v2_es_${dash}_fees-${fees}_losses-${losses}`;
    if (s[k]) {
      log(k, { ya: s[k] });
      continue;
    }
    const a = await v2('POST', '/v2/core/accounts', mk('es', 'eur', dash, fees, losses));
    log(k, resumen(a));
    if (!a.__error) s[k] = a.id;
  }
}
// solo recipient (sin merchant) con panel express
{
  const k = 'v2_es_express_solo_recipient_app_app';
  if (!s[k]) {
    const a = await v2(
      'POST',
      '/v2/core/accounts',
      mk('es', 'eur', 'express', 'application', 'stripe', 'solo_recipient'),
    );
    log(k, resumen(a));
    if (!a.__error) s[k] = a.id;
  }
}
saveState(s);
// B) Países: v2 (fees application, losses stripe, express) y v1 (controller equivalente, version preview)
const paises = {
  mx: 'mxn',
  br: 'brl',
  us: 'usd',
  gb: 'gbp',
  ch: 'chf',
  ca: 'cad',
  fr: 'eur',
  ar: 'ars',
  co: 'cop',
  cl: 'clp',
  pe: 'pen',
};
for (const [c, cur] of Object.entries(paises)) {
  const k2 = `pais_v2_${c}`;
  if (!s[k2]) {
    const a = await v2('POST', '/v2/core/accounts', mk(c, cur, 'express', 'application', 'stripe'));
    log(k2, resumen(a));
    if (!a.__error) s[k2] = a.id;
    else s[k2 + '_err'] = a.__error.message;
  }
  const k1 = `pais_v1_${c}`;
  if (!s[k1]) {
    const a = await stripe(
      'POST',
      '/v1/accounts',
      {
        country: c.toUpperCase(),
        email: `creador-v1-${c}@example.com`,
        metadata: meta,
        controller: {
          stripe_dashboard: { type: 'express' },
          fees: { payer: 'application' },
          losses: { payments: 'stripe' },
          requirement_collection: 'stripe',
        },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      },
      { soft: true, version: PREVIEW },
    );
    log(
      k1,
      a.__error
        ? { error: a.__error.message }
        : {
            id: a.id,
            country: a.country,
            default_currency: a.default_currency,
            caps: a.capabilities,
            tos: a.tos_acceptance,
          },
    );
    if (!a.__error) s[k1] = a.id;
    else s[k1 + '_err'] = a.__error.message;
  }
  // solo transfers + recipient agreement (v1)
  const kr = `pais_v1_recipient_${c}`;
  if (!s[kr]) {
    const a = await stripe(
      'POST',
      '/v1/accounts',
      {
        country: c.toUpperCase(),
        email: `creador-v1r-${c}@example.com`,
        metadata: meta,
        controller: {
          stripe_dashboard: { type: 'express' },
          fees: { payer: 'application' },
          losses: { payments: 'stripe' },
          requirement_collection: 'stripe',
        },
        capabilities: { transfers: { requested: true } },
        tos_acceptance: { service_agreement: 'recipient' },
      },
      { soft: true, version: PREVIEW },
    );
    log(
      kr,
      a.__error
        ? { error: a.__error.message }
        : { id: a.id, country: a.country, caps: a.capabilities, tos: a.tos_acceptance },
    );
    if (!a.__error) s[kr] = a.id;
    else s[kr + '_err'] = a.__error.message;
  }
}
saveState(s);
