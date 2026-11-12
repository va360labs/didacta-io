import { stripe, log, loadState, saveState } from './lib.mjs';
const s = loadState();
const A = { account: s.std };
const V = '2024-12-18.acacia'; // versión que fija el producto
const bt = async (id, opts) => {
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
      desc: f.description,
    })),
  };
};
async function inspect(label, piId) {
  const pi = await stripe(
    'GET',
    '/v1/payment_intents/' + piId,
    { expand: ['latest_charge.balance_transaction', 'latest_charge.application_fee'] },
    A,
  );
  const ch = pi.latest_charge;
  const fee = ch.application_fee;
  const out = {
    pi: pi.id,
    charge: ch.id,
    amount: ch.amount,
    currency: ch.currency,
    conectada_bt: ch.balance_transaction && (await bt(ch.balance_transaction.id, A)),
  };
  if (fee) {
    const f = await stripe('GET', '/v1/application_fees/' + fee.id);
    out.fee = {
      id: f.id,
      amount: f.amount,
      currency: f.currency,
      amount_refunded: f.amount_refunded,
      refunded: f.refunded,
    };
    out.plataforma_bt = f.balance_transaction ? await bt(f.balance_transaction) : null;
  }
  log(label, out);
  return out;
}
// 1. venta única ya hecha (100 EUR, comisión 10)
s.a_oneoff = 'pi_3Uat8QK2tqCUabsl0rVz0FZs';
await inspect('A1 venta unica EUR', s.a_oneoff);

// 1b. misma llamada con la versión de API que fija el producto
const piV = await stripe(
  'POST',
  '/v1/payment_intents',
  {
    amount: 4900,
    currency: 'eur',
    payment_method: 'pm_card_visa',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    application_fee_amount: 490,
  },
  { ...A, version: V, soft: true },
);
log(
  'A1b venta con version del producto',
  piV.__error ?? { id: piV.id, status: piV.status, fee: piV.application_fee_amount },
);
s.a_oneoff_v = piV.id;

// 2. Checkout Sessions (lo que crea hoy el producto) con comisión, en la conectada
const prod = await stripe('POST', '/v1/products', { name: 'Auditoria: curso de prueba' }, A);
const priceOne = await stripe(
  'POST',
  '/v1/prices',
  { product: prod.id, unit_amount: 10000, currency: 'eur' },
  A,
);
const priceRec = await stripe(
  'POST',
  '/v1/prices',
  { product: prod.id, unit_amount: 2900, currency: 'eur', recurring: { interval: 'month' } },
  A,
);
const cs1 = await stripe(
  'POST',
  '/v1/checkout/sessions',
  {
    mode: 'payment',
    line_items: [{ price: priceOne.id, quantity: 1 }],
    success_url: 'https://example.com/ok',
    cancel_url: 'https://example.com/ko',
    allow_promotion_codes: true,
    payment_intent_data: { application_fee_amount: 1000, metadata: { orderId: 'auditoria' } },
  },
  { ...A, version: V, soft: true },
);
log(
  'A2 checkout pago unico con comision',
  cs1.__error ?? { id: cs1.id, status: cs1.status, url_host: new URL(cs1.url).host },
);
const cs2 = await stripe(
  'POST',
  '/v1/checkout/sessions',
  {
    mode: 'subscription',
    line_items: [{ price: priceRec.id, quantity: 1 }],
    success_url: 'https://example.com/ok',
    cancel_url: 'https://example.com/ko',
    allow_promotion_codes: true,
    subscription_data: { application_fee_percent: 10, trial_period_days: 7 },
  },
  { ...A, version: V, soft: true },
);
log('A2 checkout suscripcion con comision %', cs2.__error ?? { id: cs2.id, status: cs2.status });
s.a_cs = [cs1.id, cs2.id];
s.a_prices = { one: priceOne.id, rec: priceRec.id };

// 3. suscripción con application_fee_percent
const cus = await stripe(
  'POST',
  '/v1/customers',
  { email: 'alumno+auditoria@example.com', name: 'Alumno de prueba' },
  A,
);
const pm = await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: cus.id }, A);
const sub = await stripe(
  'POST',
  '/v1/subscriptions',
  {
    customer: cus.id,
    items: [{ price: priceRec.id }],
    default_payment_method: pm.id,
    application_fee_percent: 10,
    expand: ['latest_invoice'],
  },
  { ...A, soft: true },
);
if (sub.__error) log('A3 suscripcion ERROR', sub.__error);
else {
  s.a_sub = sub.id;
  s.a_cus = cus.id;
  const inv = sub.latest_invoice;
  log('A3 suscripcion', {
    sub: sub.id,
    status: sub.status,
    application_fee_percent: sub.application_fee_percent,
    invoice: inv.id,
    invoice_status: inv.status,
    amount_paid: inv.amount_paid,
  });
  const pays = await stripe(
    'GET',
    '/v1/invoice_payments',
    { invoice: inv.id },
    { ...A, soft: true },
  );
  let piId = inv.payment_intent ?? pays?.data?.[0]?.payment?.payment_intent;
  if (piId) {
    s.a_sub_pi = piId;
    await inspect('A3 primera factura', piId);
  } else log('A3 sin PI localizable', pays.__error ?? pays.data);
}
saveState(s);
