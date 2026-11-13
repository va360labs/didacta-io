import { stripe, log, loadState, saveState } from './lib.mjs';
const s = loadState();
// 1. ¿se puede poner comisión con la clave "propia" (sin contexto de Connect), que es como cobra hoy el producto?
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
  },
  { soft: true },
);
log(
  'comision sin Stripe-Account (camino actual: clave pegada)',
  p.__error ? { error: p.__error.message } : { id: p.id, status: p.status },
);
// 2. eventos que ve la plataforma de la cuenta conectada (lo que llegaría a un webhook de Connect)
const ev = await stripe('GET', '/v1/events', { limit: 100 }, { account: s.std });
const tipos = {};
for (const e of ev.data) tipos[e.type] = (tipos[e.type] ?? 0) + 1;
log('eventos en la conectada', {
  total: ev.data.length,
  account_en_evento: ev.data[0]?.account,
  tipos,
});
// 3. webhook de Connect (un solo endpoint para todas las aulas): crear y desactivar
const wh = await stripe(
  'POST',
  '/v1/webhook_endpoints',
  {
    url: 'https://example.com/auditoria-connect-webhook',
    connect: true,
    enabled_events: [
      'checkout.session.completed',
      'invoice.paid',
      'charge.refunded',
      'charge.dispute.created',
      'account.updated',
    ],
    description: 'auditoria 2026-11-12 (desactivado)',
  },
  { soft: true },
);
if (wh.__error) log('webhook connect ERROR', wh.__error.message);
else {
  const off = await stripe('POST', '/v1/webhook_endpoints/' + wh.id, { disabled: true });
  log('webhook connect', { id: wh.id, application: wh.application, status: off.status });
  s.wh_connect = wh.id;
}
// 4. saldos finales
const bal = await stripe('GET', '/v1/balance');
log('saldo plataforma', {
  available: bal.available.map((b) => `${b.amount} ${b.currency}`),
  pending: bal.pending.map((b) => `${b.amount} ${b.currency}`),
  connect_reserved: bal.connect_reserved?.map((b) => `${b.amount} ${b.currency}`),
});
const fees = await stripe('GET', '/v1/application_fees', { limit: 100 });
log('application_fees totales', {
  n: fees.data.length,
  por_cuenta: fees.data.reduce((m, f) => ((m[f.account] = (m[f.account] ?? 0) + 1), m), {}),
});
saveState(s);
