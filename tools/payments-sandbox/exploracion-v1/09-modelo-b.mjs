import { stripe, log, loadState, saveState, sleep } from './lib.mjs';
const s = loadState();
const DEST = 'acct_1Uad6yGVFsjvsVhI'; // cuenta Express de muestra que creó Stripe al activar Connect
const bt = async (id, opts) => {
  if (!id) return null;
  const b = await stripe(
    'GET',
    '/v1/balance_transactions/' + (typeof id === 'string' ? id : id.id),
    {},
    opts,
  );
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
const pay = (amount, currency, fee, pm = 'pm_card_visa', extra = {}) =>
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
      transfer_data: { destination: DEST },
      ...extra,
    },
    { soft: true },
  );
async function inspect(label, piId) {
  let pi, ch;
  for (let i = 0; i < 10; i++) {
    pi = await stripe('GET', '/v1/payment_intents/' + piId, {
      expand: ['latest_charge.transfer', 'latest_charge.application_fee'],
    });
    ch = pi.latest_charge;
    if (ch?.balance_transaction && ch.transfer) break;
    await sleep(1500);
  }
  const out = {
    pi: pi.id,
    charge: ch.id,
    cobrado: `${ch.amount} ${ch.currency}`,
    plataforma_cobro_bt: await bt(ch.balance_transaction),
    transfer: ch.transfer && {
      id: ch.transfer.id,
      amount: ch.transfer.amount,
      currency: ch.transfer.currency,
      reversed: ch.transfer.amount_reversed,
      destination_payment: ch.transfer.destination_payment,
    },
    fee: ch.application_fee && {
      id: ch.application_fee.id,
      amount: ch.application_fee.amount,
      currency: ch.application_fee.currency,
      refunded: ch.application_fee.amount_refunded,
      bt: await bt(ch.application_fee.balance_transaction),
    },
  };
  if (ch.transfer?.balance_transaction)
    out.plataforma_transfer_bt = await bt(ch.transfer.balance_transaction);
  log(label, out);
  return out;
}
const p1 = await pay(10000, 'eur', 1000);
if (p1.__error) {
  log('B1 ERROR', { msg: p1.__error.message });
  process.exit(0);
}
s.b_oneoff = p1.id;
await inspect('B1 venta unica destino', p1.id);
const p1b = await pay(10000, 'eur', 1000, 'pm_card_visa', { on_behalf_of: DEST });
if (p1b.__error) log('B1b on_behalf_of ERROR', { msg: p1b.__error.message });
else {
  s.b_obo = p1b.id;
  await inspect('B1b con on_behalf_of', p1b.id);
}
saveState(s);

// reembolsos
for (const [k, params] of Object.entries({
  total_revirtiendo_todo: { reverse_transfer: true, refund_application_fee: true },
  total_sin_revertir: {},
  parcial40_revirtiendo: { amount: 4000, reverse_transfer: true, refund_application_fee: true },
})) {
  const pi = await pay(10000, 'eur', 1000);
  await sleep(2500);
  const ref = await stripe(
    'POST',
    '/v1/refunds',
    { payment_intent: pi.id, ...params },
    { soft: true },
  );
  await sleep(2000);
  await inspect('B4 ' + k, pi.id);
  log(
    'B4 ' + k + ' refund',
    ref.__error
      ? { error: ref.__error.message }
      : {
          id: ref.id,
          amount: ref.amount,
          bt: await bt(ref.balance_transaction),
          transfer_reversal: ref.transfer_reversal,
        },
  );
}
// rechazada
const dec = await pay(10000, 'eur', 1000, 'pm_card_chargeDeclined');
log(
  'B5 rechazada',
  dec.__error ? { code: dec.__error.code, pi: dec.__error.payment_intent?.id } : dec.status,
);
// disputa
const dis = await pay(10000, 'eur', 1000, 'pm_card_createDispute');
s.b_dispute_pi = dis.id;
saveState(s);
await sleep(6000);
await inspect('B6 disputa cobro', dis.id);
const disputes = await stripe('GET', '/v1/disputes', { payment_intent: dis.id });
for (const d of disputes.data)
  log('B6 disputa', {
    id: d.id,
    status: d.status,
    amount: d.amount,
    bts: d.balance_transactions.map((b) => ({
      id: b.id,
      type: b.type,
      amount: b.amount,
      fee: b.fee,
      net: b.net,
    })),
  });
// usd
const us = await pay(10000, 'usd', 1000);
if (us.__error) log('B7 usd ERROR', us.__error.message);
else {
  s.b_usd = us.id;
  await inspect('B7 usd', us.id);
}
saveState(s);
