import { stripe, log, loadState, saveState, sleep, bt } from './lib2.mjs';
const s = loadState();
const C = s.creador_ES;
const B = (id, o) => bt(stripe, id, o);
for (const k of ['cs_pago_obo', 'cs_sub_obo']) {
  const cs = await stripe('GET', '/v1/checkout/sessions/' + s.cs[k].id, {
    expand: ['payment_intent.latest_charge.balance_transaction', 'subscription', 'invoice'],
  });
  let ch = cs.payment_intent?.latest_charge;
  let inv = cs.invoice;
  if (!ch && inv) {
    const pays = await stripe('GET', '/v1/invoice_payments', { invoice: inv.id });
    const pi = await stripe('GET', '/v1/payment_intents/' + pays.data[0].payment.payment_intent, {
      expand: ['latest_charge.balance_transaction'],
    });
    ch = pi.latest_charge;
  }
  if (!ch) {
    log(k, { status: cs.status, payment_status: cs.payment_status });
    continue;
  }
  for (let i = 0; i < 10 && !ch.balance_transaction; i++) {
    await sleep(1200);
    ch = await stripe('GET', '/v1/charges/' + ch.id, { expand: ['balance_transaction'] });
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
      transfer_group: k,
    },
    { soft: true },
  );
  log(k, {
    session: cs.id,
    status: cs.status,
    payment_status: cs.payment_status,
    pi: ch.payment_intent,
    charge: ch.id,
    on_behalf_of: ch.on_behalf_of,
    descriptor: ch.calculated_statement_descriptor,
    tarjeta: ch.payment_method_details?.card?.country,
    sub: cs.subscription?.id,
    sub_obo: cs.subscription?.on_behalf_of,
    invoice: inv?.id,
    invoice_issuer: inv?.issuer,
    bt: await B(b.id),
    bruto,
    fee,
    comision,
    paraCreador,
    transfer: tr.__error
      ? { error: tr.__error.message }
      : { id: tr.id, bt: tr.balance_transaction, amount: tr.amount },
    receipt: !!ch.receipt_url,
  });
  s.cs[k].customer = cs.customer;
  saveState(s);
}
// Portal de cliente: ¿una configuración por creador?
const cfg = await stripe(
  'POST',
  '/v1/billing_portal/configurations',
  {
    business_profile: { headline: 'Academia Prueba ES · gestiona tu membresía' },
    features: {
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
    },
    metadata: { creador: C },
  },
  { soft: true },
);
log(
  'portal: configuración propia del creador',
  cfg.__error
    ? { error: cfg.__error.message }
    : { id: cfg.id, headline: cfg.business_profile?.headline, is_default: cfg.is_default },
);
if (!cfg.__error && s.cs.cs_sub_obo.customer) {
  for (const [k, extra] of Object.entries({
    con_config: { configuration: cfg.id },
    con_obo: { configuration: cfg.id, on_behalf_of: C },
  })) {
    const ps = await stripe(
      'POST',
      '/v1/billing_portal/sessions',
      { customer: s.cs.cs_sub_obo.customer, return_url: 'https://example.com/volver', ...extra },
      { soft: true },
    );
    log(
      'portal sesión ' + k,
      ps.__error
        ? { error: ps.__error.message }
        : {
            id: ps.id,
            configuration: ps.configuration,
            on_behalf_of: ps.on_behalf_of,
            host: new URL(ps.url).host,
          },
    );
    if (!ps.__error) {
      s['portal_' + k] = ps.url;
      saveState(s);
    }
  }
}
