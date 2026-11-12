import { stripe, v2, log, loadState, saveState } from './lib2.mjs';
const s = loadState();
const id = s['v2_es_express_fees-application_losses-stripe'];
const a = await v2(
  'GET',
  `/v2/core/accounts/${id}?include=requirements&include=identity&include=defaults&include=configuration.merchant&include=configuration.recipient`,
);
log(
  'requisitos',
  a.__error ?? {
    summary: a.requirements?.summary,
    entries: a.requirements?.entries?.map(
      (e) =>
        `${e.description} [${e.awaiting_action_from}] ${e.impact?.restricts_capabilities?.map((c) => c.capability).join('+')}`,
    ),
  },
);
// Intento de rellenar identidad por API (requirements_collector = stripe)
const up = await v2('POST', `/v2/core/accounts/${id}`, {
  identity: {
    entity_type: 'individual',
    business_details: {},
    individual: {
      given_name: 'Jenny',
      surname: 'Rosen',
      email: 'creadora-prueba@example.com',
      phone: '+34600000000',
      date_of_birth: { day: 1, month: 1, year: 1901 },
      address: { line1: 'address_full_match', city: 'Madrid', postal_code: '28001', country: 'es' },
    },
    attestations: {
      terms_of_service: { account: { date: new Date().toISOString(), ip: '8.8.8.8' } },
    },
  },
  include: ['requirements', 'identity'],
});
log(
  'update v2 identidad+tos',
  up.__error
    ? up
    : {
        ok: true,
        summary: up.requirements?.summary,
        entries: up.requirements?.entries?.map((e) => e.description),
      },
);
// v1 view
const v1 = await stripe('GET', '/v1/accounts/' + id);
log('vista v1', {
  type: v1.type,
  controller: v1.controller,
  caps: v1.capabilities,
  due: v1.requirements?.currently_due,
  payouts: v1.settings?.payouts,
});
// Enlace de alta alojada
const l = await stripe(
  'POST',
  '/v1/account_links',
  {
    account: id,
    type: 'account_onboarding',
    refresh_url: 'https://example.com/refresh',
    return_url: 'https://example.com/return',
  },
  { soft: true },
);
if (l.__error) log('account_link', l.__error.message);
else {
  s.onb_url = l.url;
  log('account_link', { ok: true, host: new URL(l.url).host });
}
saveState(s);
