import { execSync } from 'node:child_process';
import { stripe, sleep } from './lib.mjs';
import { api, sign, load, save, log, PG_CONTAINER } from './c-lib.mjs';
const s = load();
const sql = (q) =>
  execSync(
    `docker exec ${PG_CONTAINER} psql -U didacta_test -d didacta_test -t -A -F " | " -c "${q.replace(/"/g, '\\"')}"`,
  )
    .toString()
    .trim();
const estado = (l) =>
  log(l, {
    order: sql(
      `select status, amount_paid, currency, customer_email, user_id is not null as con_usuario, stripe_payment_intent_id from mod_billing_order where stripe_session_id='${s.sessionId}'`,
    ),
    matriculas: sql(
      `select e.status, e.source, u.email from mod_learning_enrollment e join "user" u on u.id=e.user_id where e.course_id='${s.courseId}'`,
    ),
  });
const phase = process.argv[2];
if (phase === 'pago') {
  estado('ANTES del webhook (ya cobrado en Stripe)');
  const evs = await stripe('GET', '/v1/events', { type: 'checkout.session.completed', limit: 20 });
  const ev = evs.data.find((e) => e.data.object.id === s.sessionId);
  if (!ev) {
    console.log('evento no encontrado');
    process.exit(1);
  }
  s.evPago = ev.id;
  const raw = JSON.stringify(ev);
  const bad = await api('/api/v1/modules/billing/webhook', {
    method: 'POST',
    raw,
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': sign(raw, 'whsec_secreto_equivocado'),
    },
  });
  log('CONTROL firma mala', { status: bad.status, code: bad.body?.code });
  const ok = await api('/api/v1/modules/billing/webhook', {
    method: 'POST',
    raw,
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(raw, s.demoWhsec) },
  });
  log('webhook real firmado', { status: ok.status, body: ok.body });
  await sleep(4000);
  estado('DESPUES del webhook');
  const again = await api('/api/v1/modules/billing/webhook', {
    method: 'POST',
    raw,
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(raw, s.demoWhsec) },
  });
  await sleep(1500);
  log('reentrega (idempotencia)', {
    status: again.status,
    orders: sql(`select count(*) from mod_billing_order where stripe_session_id='${s.sessionId}'`),
    matriculas: sql(`select count(*) from mod_learning_enrollment where course_id='${s.courseId}'`),
  });
}
if (phase === 'reembolso') {
  const cs = await stripe('GET', '/v1/checkout/sessions/' + s.sessionId);
  const ref = await stripe('POST', '/v1/refunds', { payment_intent: cs.payment_intent });
  log('reembolso total en Stripe', { id: ref.id, amount: ref.amount, status: ref.status });
  let ev;
  for (let i = 0; i < 10 && !ev; i++) {
    await sleep(2000);
    const evs = await stripe('GET', '/v1/events', { type: 'charge.refunded', limit: 10 });
    ev = evs.data.find((e) => e.data.object.payment_intent === cs.payment_intent);
  }
  const raw = JSON.stringify(ev);
  const ok = await api('/api/v1/modules/billing/webhook', {
    method: 'POST',
    raw,
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(raw, s.demoWhsec) },
  });
  log('webhook charge.refunded', { status: ok.status, body: ok.body });
  await sleep(4000);
  estado('DESPUES del reembolso');
}
save(s);
