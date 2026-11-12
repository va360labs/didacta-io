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
const feeOf = async (piId) => {
  let pi, f;
  for (let i = 0; i < 8; i++) {
    pi = await stripe('GET', '/v1/payment_intents/' + piId, { expand: ['latest_charge'] }, A);
    f = await stripe('GET', '/v1/application_fees/' + pi.latest_charge.application_fee);
    if (f.balance_transaction && pi.latest_charge.balance_transaction) break;
    await sleep(1500);
  }
  return {
    charge: pi.latest_charge.id,
    fee_id: f.id,
    fee_amount: f.amount,
    fee_currency: f.currency,
    fee_refunded: f.amount_refunded,
    plataforma_bt: await bt(f.balance_transaction),
    conectada_bt: await bt(pi.latest_charge.balance_transaction, A),
  };
};

// 4. reembolsos
const r = {};
for (const [k, params] of Object.entries({
  total_sin_devolucion_comision: {},
  parcial40_con_devolucion_comision: { amount: 4000, refund_application_fee: true },
  parcial40_sin_devolucion_comision: { amount: 4000 },
})) {
  const pi = await pay(10000, 'eur', 1000);
  const ref = await stripe(
    'POST',
    '/v1/refunds',
    { payment_intent: pi.id, ...params },
    { ...A, soft: true },
  );
  await sleep(1500);
  const f = await feeOf(pi.id);
  const refBt = ref.balance_transaction ? await bt(ref.balance_transaction, A) : null;
  const feeRefunds = await stripe('GET', `/v1/application_fees/${f.fee_id}/refunds`);
  r[k] = {
    pi: pi.id,
    refund: ref.__error ? ref.__error.message : ref.id,
    refund_amount: ref.amount,
    conectada_refund_bt: refBt && {
      amount: refBt.amount,
      fee: refBt.fee,
      net: refBt.net,
      fee_details: refBt.fee_details,
    },
    fee_id: f.fee_id,
    comision: f.fee_amount,
    comision_devuelta: f.fee_refunded,
    fee_refunds: feeRefunds.data.map((x) => ({ id: x.id, amount: x.amount })),
  };
  log('A4 ' + k, r[k]);
}
s.a_refunds = r;

// 5. tarjeta rechazada
const dec = await pay(10000, 'eur', 1000, 'pm_card_chargeDeclined');
log(
  'A5 rechazada',
  dec.__error
    ? {
        code: dec.__error.code,
        decline_code: dec.__error.decline_code,
        pi: dec.__error.payment_intent?.id,
        pi_status: dec.__error.payment_intent?.status,
        charge: dec.__error.charge,
      }
    : dec.status,
);
s.a_declined = dec.__error?.payment_intent?.id;

// 6. disputa
const dis = await pay(10000, 'eur', 1000, 'pm_card_createDispute');
log('A6 disputa: cobro', dis.__error ?? { id: dis.id, status: dis.status });
s.a_dispute_pi = dis.id;

// 7. divisas
s.a_fx = {};
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
  await sleep(1500);
  const f = await feeOf(pi.id);
  s.a_fx[cur] = { pi: pi.id, ...f };
  log('A7 ' + cur, s.a_fx[cur]);
}
saveState(s);
