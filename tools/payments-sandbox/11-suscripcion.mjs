import { stripe, log, loadState, saveState, sleep, bt } from './lib2.mjs';
const s = loadState();
const C = s.creador_ES;
const B = (id, o) => bt(stripe, id, o);
const variante = process.argv[2] ?? 'sin_obo'; // sin_obo | con_obo | trial
const K = 'sub_' + variante;
const pm = process.argv[3] ?? 'pm_card_es';

if (!s.precio29) {
  const prod = await stripe('POST', '/v1/products', {
    name: 'Membresía Academia Prueba (creador ES)',
    metadata: { creador: C },
  });
  const price = await stripe('POST', '/v1/prices', {
    product: prod.id,
    unit_amount: 2900,
    currency: 'eur',
    recurring: { interval: 'month' },
    metadata: { creador: C },
  });
  s.precio29 = price.id;
  saveState(s);
}
const clock = await stripe('POST', '/v1/test_helpers/test_clocks', {
  frozen_time: Math.floor(Date.now() / 1000),
  name: 'reloj ' + K,
});
const cus = await stripe('POST', '/v1/customers', {
  email: `alumno-${variante}@example.com`,
  name: 'Alumno de prueba',
  test_clock: clock.id,
  metadata: { creador: C },
});
const pmo = await stripe('POST', `/v1/payment_methods/${pm}/attach`, { customer: cus.id });
await stripe('POST', '/v1/customers/' + cus.id, {
  invoice_settings: { default_payment_method: pmo.id },
});
const params = {
  customer: cus.id,
  items: [{ price: s.precio29 }],
  metadata: { creador: C },
  expand: ['latest_invoice'],
};
if (variante === 'con_obo') params.on_behalf_of = C;
if (variante === 'trial') params.trial_period_days = 7;
const sub = await stripe('POST', '/v1/subscriptions', params, { soft: true });
if (sub.__error) {
  log(K + ' ERROR al crear', { msg: sub.__error.message });
  process.exit(0);
}
log(K + ' creada', {
  sub: sub.id,
  status: sub.status,
  on_behalf_of: sub.on_behalf_of,
  transfer_data: sub.transfer_data,
  factura: sub.latest_invoice?.id,
  factura_status: sub.latest_invoice?.status,
  total: sub.latest_invoice?.total,
  trial_end: sub.trial_end,
});
s[K] = { sub: sub.id, clock: clock.id, customer: cus.id, facturas: [] };
saveState(s);

// "invoice.paid": localizar el cobro de la factura, leer la comisión real y transferir
async function liquidarFactura(invId, n) {
  let ch = null,
    inv;
  for (let i = 0; i < 20 && !ch?.balance_transaction; i++) {
    inv = await stripe('GET', '/v1/invoices/' + invId, {
      expand: ['payments.data.payment.payment_intent'],
    });
    let piId =
      inv.payments?.data?.[0]?.payment?.payment_intent?.id ??
      inv.payments?.data?.[0]?.payment?.payment_intent ??
      inv.payment_intent;
    if (!piId) {
      const pays = await stripe('GET', '/v1/invoice_payments', { invoice: invId }, { soft: true });
      piId = pays?.data?.[0]?.payment?.payment_intent;
    }
    if (piId) {
      const pi = await stripe('GET', '/v1/payment_intents/' + piId, {
        expand: ['latest_charge.balance_transaction'],
      });
      ch = pi.latest_charge;
    }
    if (!ch?.balance_transaction) await sleep(1500);
  }
  if (!ch) {
    log(`${K} factura ${n} sin cobro`, {
      invoice: invId,
      status: inv.status,
      amount_paid: inv.amount_paid,
      total: inv.total,
    });
    return;
  }
  const b = ch.balance_transaction;
  const bruto = b.amount,
    fee = b.fee,
    comision = Math.round(bruto * 0.05),
    paraCreador = bruto - fee - comision;
  const tr = await stripe(
    'POST',
    '/v1/transfers',
    {
      amount: paraCreador,
      currency: b.currency,
      destination: C,
      source_transaction: ch.id,
      transfer_group: 'sub_' + sub.id,
      metadata: { invoice: invId, subscription: sub.id },
      expand: ['balance_transaction', 'destination_payment'],
    },
    { soft: true },
  );
  const out = {
    invoice: invId,
    status: inv.status,
    billing_reason: inv.billing_reason,
    issuer: inv.issuer,
    charge: ch.id,
    on_behalf_of: ch.on_behalf_of,
    descriptor: ch.calculated_statement_descriptor,
    bt_cobro: await B(b.id),
    bruto,
    fee,
    comision,
    paraCreador,
    transfer: tr.__error
      ? { error: tr.__error.message }
      : {
          id: tr.id,
          bt: tr.balance_transaction.id,
          importe: tr.amount,
          pago_creador: tr.destination_payment?.id,
        },
    neto_plataforma: bruto - fee - paraCreador,
  };
  log(`${K} factura ${n}`, out);
  s[K].facturas.push({
    invoice: invId,
    charge: ch.id,
    bt: b.id,
    fee,
    transfer: tr.id,
    bt_transfer: tr.balance_transaction?.id,
  });
  saveState(s);
}
if (variante !== 'trial') await liquidarFactura(sub.latest_invoice.id, 1);
// Avanzar el reloj
const avanzar = async (dias) => {
  const cur = await stripe('GET', '/v1/test_helpers/test_clocks/' + clock.id);
  await stripe('POST', `/v1/test_helpers/test_clocks/${clock.id}/advance`, {
    frozen_time: cur.frozen_time + dias * 86400,
  });
  for (let i = 0; i < 60; i++) {
    const c = await stripe('GET', '/v1/test_helpers/test_clocks/' + clock.id);
    if (c.status === 'ready') return;
    await sleep(2000);
  }
};
await avanzar(variante === 'trial' ? 8 : 32);
await sleep(3000);
const invs = await stripe('GET', '/v1/invoices', { subscription: sub.id, limit: 10 });
log(
  K + ' facturas tras avanzar',
  invs.data.map((i) => ({ id: i.id, status: i.status, total: i.total, reason: i.billing_reason })),
);
const nuevas = invs.data.filter(
  (i) => i.status === 'paid' && i.total > 0 && !s[K].facturas.find((f) => f.invoice === i.id),
);
let n = 2;
for (const i of nuevas.reverse()) await liquidarFactura(i.id, n++);
const sub2 = await stripe('GET', '/v1/subscriptions/' + sub.id);
log(K + ' estado final', { status: sub2.status });
