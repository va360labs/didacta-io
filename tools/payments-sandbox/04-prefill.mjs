import { stripe, log, loadState, saveState } from './lib2.mjs';
const s = loadState();
const key = process.argv[2] ?? 'v2_es_express_fees-application_losses-stripe';
const id = s[key];
const country = process.argv[3] ?? 'es';
const up = await stripe(
  'POST',
  '/v1/accounts/' + id,
  {
    business_type: 'individual',
    business_profile: {
      mcc: '8299',
      product_description: 'Cursos online y membresias (cuenta de prueba)',
      url: 'https://accessible.stripe.com',
      support_phone: '+34600000000',
      name: 'Academia de prueba',
    },
    individual: {
      first_name: 'Jenny',
      last_name: 'Rosen',
      email: 'creadora-prueba@example.com',
      phone: '+34600000000',
      dob: { day: 1, month: 1, year: 1901 },
      nationality: country.toUpperCase(),
      address: {
        line1: 'address_full_match',
        city: 'Madrid',
        postal_code: '28001',
        country: country.toUpperCase(),
      },
    },
  },
  { soft: true },
);
log(
  'prefill v1',
  up.__error ? { error: up.__error.message } : { due: up.requirements?.currently_due },
);
const ext = await stripe(
  'POST',
  `/v1/accounts/${id}/external_accounts`,
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
log(
  'cuenta bancaria',
  ext.__error ? { error: ext.__error.message } : { id: ext.id, last4: ext.last4 },
);
const a = await stripe('GET', '/v1/accounts/' + id);
log('estado', {
  caps: a.capabilities,
  due: a.requirements?.currently_due,
  charges_enabled: a.charges_enabled,
  payouts_enabled: a.payouts_enabled,
  details_submitted: a.details_submitted,
});
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
  s['onb_url_' + key] = l.url;
  log('account_link', { ok: true });
}
saveState(s);
