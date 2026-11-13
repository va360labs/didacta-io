import { stripe, log, loadState } from './lib2.mjs';
const s = loadState();
for (const [k, acct, cur, pm] of [
  ['MX', s.creador_MX, 'mxn', 'pm_card_mx'],
  ['US', s.creador_US, 'usd', 'pm_card_visa'],
  ['GB', s.creador_GB, 'gbp', 'pm_card_gb'],
]) {
  for (const fee of [1000, 0]) {
    const p = {
      amount: 20000,
      currency: cur,
      payment_method: pm,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    };
    if (fee) p.application_fee_amount = fee;
    const pi = await stripe('POST', '/v1/payment_intents', p, { account: acct, soft: true });
    log(
      `cobro directo en ${k} ${fee ? 'con' : 'sin'} application_fee`,
      pi.__error
        ? { error: pi.__error.message, code: pi.__error.code }
        : { id: pi.id, status: pi.status, fee: pi.application_fee_amount },
    );
  }
}
