import { stripe, log, loadState, saveState, PREVIEW } from './lib2.mjs';
const s = loadState();
const meta = { creado_por: 'verificacion-diseno-pagos-2026-11-12' };
// país -> datos de prueba
const P = {
  ES: {
    cur: 'eur',
    phone: '+34600000000',
    addr: { line1: 'address_full_match', city: 'Madrid', postal_code: '28001', country: 'ES' },
    bank: { country: 'ES', currency: 'eur', account_number: 'ES0700120345030000067890' },
  },
  US: {
    cur: 'usd',
    phone: '+12015550123',
    addr: {
      line1: 'address_full_match',
      city: 'New York',
      state: 'NY',
      postal_code: '10001',
      country: 'US',
    },
    bank: {
      country: 'US',
      currency: 'usd',
      routing_number: '110000000',
      account_number: '000123456789',
    },
    extra: { id_number: '000000000', ssn_last_4: '0000' },
  },
  GB: {
    cur: 'gbp',
    phone: '+442071234567',
    addr: { line1: 'address_full_match', city: 'London', postal_code: 'SW1A 1AA', country: 'GB' },
    bank: { country: 'GB', currency: 'gbp', routing_number: '108800', account_number: '00012345' },
  },
  MX: {
    cur: 'mxn',
    phone: '+525512345678',
    addr: {
      line1: 'address_full_match',
      city: 'Ciudad de Mexico',
      state: 'CDMX',
      postal_code: '01000',
      country: 'MX',
    },
    bank: { country: 'MX', currency: 'mxn', account_number: '000000001234567897' },
    extra: { id_number: '000000000000000000' },
  },
};
for (const c of process.argv.slice(2).length ? process.argv.slice(2) : ['ES']) {
  const k = 'creador_' + c;
  if (s[k]) {
    log(k, { ya: s[k] });
    continue;
  }
  const d = P[c];
  const a = await stripe(
    'POST',
    '/v1/accounts',
    {
      country: c,
      email: `creadora-${c.toLowerCase()}-prueba@example.com`,
      metadata: meta,
      controller: {
        stripe_dashboard: { type: 'express' },
        fees: { payer: 'application' },
        losses: { payments: 'stripe' },
        requirement_collection: 'stripe',
      },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_type: 'individual',
      business_profile: {
        mcc: '8299',
        product_description: 'Cursos online y membresias (cuenta de prueba)',
        url: 'https://accessible.stripe.com',
        support_phone: d.phone,
        name: 'Academia Prueba ' + c,
      },
      individual: {
        first_name: 'Jenny',
        last_name: 'Rosen',
        email: `creadora-${c.toLowerCase()}-prueba@example.com`,
        phone: d.phone,
        dob: { day: 1, month: 1, year: 1901 },
        address: d.addr,
        ...(d.extra ?? {}),
      },
      external_account: { object: 'bank_account', account_holder_name: 'Jenny Rosen', ...d.bank },
      settings: { payments: { statement_descriptor: 'ACADEMIA PRUEBA ' + c } },
    },
    { soft: true, version: PREVIEW },
  );
  if (a.__error) {
    log(k, { error: a.__error.message });
    continue;
  }
  s[k] = a.id;
  log(k, {
    id: a.id,
    type: a.type,
    controller: a.controller,
    caps: a.capabilities,
    due: a.requirements?.currently_due,
    payouts: a.settings?.payouts,
    default_currency: a.default_currency,
  });
  const l = await stripe(
    'POST',
    '/v1/account_links',
    {
      account: a.id,
      type: 'account_onboarding',
      refresh_url: 'https://example.com/refresh',
      return_url: 'https://example.com/return',
    },
    { soft: true },
  );
  if (l.__error) log('account_link', l.__error.message);
  else {
    s['onb_' + k] = l.url;
    log('account_link ' + c, { ok: true });
  }
  saveState(s);
}
