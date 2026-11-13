import { stripe, log, loadState, saveState, sleep } from './lib.mjs';
const s = loadState();
const bt = async (id) => {
  if (!id) return null;
  const b = await stripe('GET', '/v1/balance_transactions/' + id);
  return { id: b.id, type: b.type, amount: b.amount, fee: b.fee, net: b.net, currency: b.currency };
};
async function caso(label, pmToken) {
  const cus = await stripe('POST', '/v1/customers', {
    email: `creador-${label}+auditoria@example.com`,
    name: 'Creador de prueba (modelo c)',
    metadata: { creado_por: 'auditoria-comision-2026-11-12' },
  });
  const pm = await stripe('POST', `/v1/payment_methods/${pmToken}/attach`, { customer: cus.id });
  await stripe('POST', '/v1/customers/' + cus.id, {
    invoice_settings: { default_payment_method: pm.id },
  });
  await stripe('POST', '/v1/invoiceitems', {
    customer: cus.id,
    amount: 10000,
    currency: 'eur',
    description: 'Comisión 10 % sobre 1.000,00 € de ventas de octubre',
  });
  const inv = await stripe('POST', '/v1/invoices', {
    customer: cus.id,
    collection_method: 'charge_automatically',
    auto_advance: false,
    pending_invoice_items_behavior: 'include',
  });
  await stripe('POST', `/v1/invoices/${inv.id}/finalize`, {});
  const paid = await stripe('POST', `/v1/invoices/${inv.id}/pay`, {}, { soft: true });
  await sleep(2000);
  const cur = await stripe('GET', '/v1/invoices/' + inv.id);
  const pays = await stripe('GET', '/v1/invoice_payments', { invoice: inv.id }, { soft: true });
  const piId = pays?.data?.[0]?.payment?.payment_intent;
  let cobro = null;
  if (piId) {
    const pi = await stripe('GET', '/v1/payment_intents/' + piId, { expand: ['latest_charge'] });
    cobro = {
      pi: pi.id,
      status: pi.status,
      charge: pi.latest_charge?.id,
      bt: await bt(pi.latest_charge?.balance_transaction),
    };
  }
  const out = {
    customer: cus.id,
    invoice: inv.id,
    pay_error: paid.__error
      ? { code: paid.__error.code, decline: paid.__error.decline_code }
      : null,
    invoice_status: cur.status,
    amount_due: cur.amount_due,
    amount_paid: cur.amount_paid,
    attempt_count: cur.attempt_count,
    cobro,
  };
  log('C ' + label, out);
  s['c_' + label] = out;
}
await caso('paga', 'pm_card_visa');
await caso('falla', 'pm_card_chargeCustomerFail');
saveState(s);
