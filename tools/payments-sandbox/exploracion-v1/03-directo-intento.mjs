import { stripe, log, loadState } from './lib.mjs';
const s = loadState();
const pi = await stripe(
  'POST',
  '/v1/payment_intents',
  {
    amount: 10000,
    currency: 'eur',
    payment_method: 'pm_card_visa',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    application_fee_amount: 1000,
    description: 'auditoria: curso suelto 100 EUR, comision 10%',
  },
  { account: s.std, soft: true },
);
log(
  'cobro directo en standard sin onboarding',
  pi.__error
    ? { error: pi.__error.code, msg: pi.__error.message }
    : { id: pi.id, status: pi.status, fee: pi.application_fee_amount, charge: pi.latest_charge },
);
const a = await stripe('GET', '/v1/accounts/' + s.std);
log('estado std', {
  capabilities: a.capabilities,
  charges_enabled: a.charges_enabled,
  due: a.requirements?.currently_due,
  disabled: a.requirements?.disabled_reason,
});
