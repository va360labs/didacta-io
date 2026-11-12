import { stripe, log } from './lib.mjs';
const acct = await stripe('GET', '/v1/account');
log('plataforma', {
  id: acct.id,
  country: acct.country,
  default_currency: acct.default_currency,
  charges_enabled: acct.charges_enabled,
  livemode_key: false,
  type: acct.type,
  dashboard_name: acct.settings?.dashboard?.display_name,
  controller: acct.controller,
});
const list = await stripe('GET', '/v1/accounts', { limit: 20 }, { soft: true });
if (list.__error) log('accounts.list ERROR', list.__error);
else
  log(
    'conectadas existentes',
    list.data.map((a) => ({
      id: a.id,
      type: a.type,
      country: a.country,
      charges_enabled: a.charges_enabled,
      created: a.created,
    })),
  );
const bal = await stripe('GET', '/v1/balance');
log('balance plataforma', {
  available: bal.available,
  pending: bal.pending,
  livemode: bal.livemode,
});
const fees = await stripe('GET', '/v1/application_fees', { limit: 5 }, { soft: true });
log('application_fees previos', fees.__error ?? fees.data.map((f) => f.id));
