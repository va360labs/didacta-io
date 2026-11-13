import { stripe, log, loadState, saveState, sleep } from './lib.mjs';
const s = loadState();
const A = { account: s.std };
const bt = async (id, opts) => {
  if (!id) return null;
  const b = await stripe('GET', '/v1/balance_transactions/' + id, {}, opts);
  return {
    id: b.id,
    type: b.type,
    amount: b.amount,
    fee: b.fee,
    net: b.net,
    currency: b.currency,
    exchange_rate: b.exchange_rate,
    fee_details: b.fee_details.map((f) => ({
      type: f.type,
      amount: f.amount,
      currency: f.currency,
    })),
  };
};
const pay = (amount, currency, fee, pm = 'pm_card_visa') =>
  stripe(
    'POST',
    '/v1/payment_intents',
    {
      amount,
      currency,
      payment_method: pm,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      application_fee_amount: fee,
    },
    { ...A, soft: true },
  );
s.a_fx = s.a_fx ?? {};
for (const [cur, amount, fee] of [
  ['usd', 10000, 1000],
  ['mxn', 200000, 20000],
  ['brl', 50000, 5000],
]) {
  const pi = await pay(amount, cur, fee);
  if (pi.__error) {
    log('A7 ' + cur + ' ERROR', pi.__error.message);
    continue;
  }
  let ch, f;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const p = await stripe('GET', '/v1/payment_intents/' + pi.id, { expand: ['latest_charge'] }, A);
    ch = p.latest_charge;
    if (ch.application_fee && ch.balance_transaction) {
      f = await stripe('GET', '/v1/application_fees/' + ch.application_fee);
      if (f.balance_transaction) break;
    }
  }
  s.a_fx[cur] = {
    pi: pi.id,
    status: pi.status,
    charge: ch.id,
    cobrado: `${ch.amount} ${ch.currency}`,
    fee_id: f?.id,
    fee: f && `${f.amount} ${f.currency}`,
    conectada_bt: await bt(ch.balance_transaction, A),
    plataforma_bt: f && (await bt(f.balance_transaction)),
  };
  log('A7 ' + cur, s.a_fx[cur]);
}
saveState(s);
// disputa
s.a_dispute_pi = 'pi_3UatA3K2tqCUabsl097FE52R';
const p = await stripe(
  'GET',
  '/v1/payment_intents/' + s.a_dispute_pi,
  { expand: ['latest_charge'] },
  A,
);
const ch = p.latest_charge;
const disputes = await stripe('GET', '/v1/disputes', { charge: ch.id }, A);
const f = await stripe('GET', '/v1/application_fees/' + ch.application_fee);
const out = {
  charge: ch.id,
  disputed: ch.disputed,
  fee_id: f.id,
  comision: f.amount,
  comision_devuelta: f.amount_refunded,
  disputas: [],
};
for (const d of disputes.data) {
  const bts = [];
  for (const b of d.balance_transactions)
    bts.push({
      id: b.id,
      type: b.type,
      amount: b.amount,
      fee: b.fee,
      net: b.net,
      fee_details: b.fee_details.map((x) => ({ type: x.type, amount: x.amount })),
    });
  out.disputas.push({ id: d.id, status: d.status, amount: d.amount, reason: d.reason, bts });
}
log('A6 disputa', out);
const balC = await stripe('GET', '/v1/balance', {}, A);
log('saldo conectada', {
  available: balC.available.map((b) => `${b.amount} ${b.currency}`),
  pending: balC.pending.map((b) => `${b.amount} ${b.currency}`),
});
saveState(s);
