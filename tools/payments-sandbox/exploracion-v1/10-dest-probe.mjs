import { stripe, log, loadState } from './lib.mjs';
const s = loadState();
const p = await stripe(
  'POST',
  '/v1/payment_intents',
  {
    amount: 10000,
    currency: 'eur',
    payment_method: 'pm_card_visa',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    application_fee_amount: 1000,
    transfer_data: { destination: 'acct_1Uad6yGVFsjvsVhI' },
  },
  { soft: true },
);
log(
  'destino a la cuenta de muestra',
  p.__error ? { msg: p.__error.message } : { id: p.id, status: p.status },
);
// cómo se hizo el cobro previo de muestra
const ch = await stripe(
  'GET',
  '/v1/charges/ch_3Uad77GVFsqqzpBi1D7caasH',
  { expand: ['balance_transaction', 'transfer'] },
  { soft: true },
);
log(
  'cobro de muestra previo',
  ch.__error
    ? ch.__error.message
    : {
        amount: ch.amount,
        on_behalf_of: ch.on_behalf_of,
        transfer_data: ch.transfer_data,
        application_fee_amount: ch.application_fee_amount,
        metadata: ch.metadata,
        description: ch.description,
        bt: {
          amount: ch.balance_transaction.amount,
          fee: ch.balance_transaction.fee,
          net: ch.balance_transaction.net,
        },
      },
);
const l = await stripe(
  'POST',
  '/v1/account_links',
  {
    account: s.dest_stripe_riesgo_sin_panel,
    type: 'account_onboarding',
    refresh_url: 'https://example.com/refresh',
    return_url: 'https://example.com/return',
  },
  { soft: true },
);
log('link onboarding dest', l.__error ? l.__error.message : { ok: true });
