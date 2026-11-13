import { stripe, v2, log, loadState, saveState } from './lib2.mjs';
const s = loadState();
const k = process.argv[2] ?? 'creador_ES2';
if (s[k]) {
  log(k, { ya: s[k] });
  process.exit(0);
}
const body = {
  contact_email: 'creadora-es2-prueba@example.com',
  display_name: 'Academia Prueba ES2',
  dashboard: 'express',
  identity: {
    country: 'es',
    entity_type: 'individual',
    individual: {
      given_name: 'Jenny',
      surname: 'Rosen',
      email: 'creadora-es2-prueba@example.com',
      phone: '+34600000000',
      date_of_birth: { day: 1, month: 1, year: 1901 },
      nationalities: ['es'],
      address: { line1: 'address_full_match', city: 'Madrid', postal_code: '28001', country: 'es' },
    },
  },
  configuration: {
    merchant: {
      mcc: '8299',
      support: { phone: '+34600000000' },
      statement_descriptor: { descriptor: 'ACADEMIA PRUEBA ES2' },
      capabilities: { card_payments: { requested: true } },
    },
    recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
  },
  defaults: {
    currency: 'eur',
    locales: ['es-ES'],
    profile: {
      business_url: 'https://accessible.stripe.com',
      product_description: 'Cursos online y membresias (cuenta de prueba)',
    },
    responsibilities: { fees_collector: 'application', losses_collector: 'stripe' },
  },
  metadata: { creado_por: 'verificacion-diseno-pagos-2026-11-12' },
  include: [
    'configuration.merchant',
    'configuration.recipient',
    'identity',
    'defaults',
    'requirements',
  ],
};
const a = await v2('POST', '/v2/core/accounts', body);
if (a.__error) {
  log(k + ' ERROR', a);
  process.exit(0);
}
s[k] = a.id;
saveState(s);
console.log(
  'RESPUESTA v2 (resumida):',
  JSON.stringify(
    {
      id: a.id,
      object: a.object,
      dashboard: a.dashboard,
      applied_configurations: a.applied_configurations,
      defaults: { currency: a.defaults?.currency, responsibilities: a.defaults?.responsibilities },
      merchant: {
        card_payments: a.configuration?.merchant?.capabilities?.card_payments,
        mcc: a.configuration?.merchant?.mcc,
        statement_descriptor: a.configuration?.merchant?.statement_descriptor,
      },
      recipient: {
        stripe_transfers:
          a.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers,
      },
      requisitos: a.requirements?.entries?.map((e) => e.description),
    },
    null,
    1,
  ),
);
const ext = await stripe(
  'POST',
  `/v1/accounts/${a.id}/external_accounts`,
  {
    external_account: {
      object: 'bank_account',
      country: 'ES',
      currency: 'eur',
      account_number: 'ES0700120345030000067890',
      account_holder_name: 'Jenny Rosen',
    },
  },
  { soft: true },
);
log('cuenta bancaria (v1)', ext.__error ? { error: ext.__error.message } : { id: ext.id });
const v1 = await stripe('GET', '/v1/accounts/' + a.id);
log('vista v1', {
  type: v1.type,
  controller: v1.controller,
  due: v1.requirements?.currently_due,
  payouts: v1.settings?.payouts,
});
// control del calendario de pagos por la plataforma
const sch = await stripe(
  'POST',
  '/v1/accounts/' + a.id,
  {
    settings: {
      payouts: { schedule: { interval: 'weekly', weekly_anchor: 'monday', delay_days: 14 } },
    },
  },
  { soft: true },
);
log(
  'calendario fijado por la plataforma',
  sch.__error ? { error: sch.__error.message } : sch.settings.payouts,
);
const l = await stripe(
  'POST',
  '/v1/account_links',
  {
    account: a.id,
    type: 'account_onboarding',
    refresh_url: 'https://example.com/refresh',
    return_url: 'https://example.com/return',
    collection_options: { fields: 'eventually_due' },
  },
  { soft: true },
);
if (l.__error) log('account_link', l.__error.message);
else {
  s['onb_' + k] = l.url;
  saveState(s);
  console.log('ONB', l.url);
}
