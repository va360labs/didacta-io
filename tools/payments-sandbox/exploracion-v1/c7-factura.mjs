import { execSync } from 'node:child_process';
import { stripe, sleep } from './lib.mjs';
import { api, sign, load, log, HOST_DEMO, PG_CONTAINER } from './c-lib.mjs';
const s = load();
const sql = (q) =>
  execSync(
    `docker exec ${PG_CONTAINER} psql -U didacta_test -d didacta_test -t -A -F " | " -c "${q.replace(/"/g, '\\"')}"`,
  )
    .toString()
    .trim();
const evs = await stripe('GET', '/v1/events', { type: 'invoice.paid', limit: 20 });
const ev = evs.data.find((e) => e.data.object.id === 'in_1UatL6GVFsqqzpBi9e6k7cvZ');
const raw = JSON.stringify(ev);
const r = await api('/api/v1/modules/subscriptions/webhook', {
  method: 'POST',
  raw,
  host: HOST_DEMO,
  headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(raw, s.demoWhsec) },
});
log('reintento invoice.paid', { status: r.status, err: r.body?.message });
await sleep(2000);
log(
  'facturas guardadas',
  sql(
    `select amount, currency, paid_at is not null as pagada, stripe_invoice_id from mod_subscriptions_invoice`,
  ),
);
log(
  'eventos archivados',
  sql(
    `select type, processed_at is not null as ok, left(coalesce(error_message,''),60) from mod_subscriptions_webhook_event order by received_at`,
  ),
);
// métricas de negocio que ya calcula el producto (base para medir ventas por aula)
const m = await api('/api/v1/admin/business-metrics', { bearer: s.adminTok });
log('metricas de negocio', { status: m.status, body: JSON.stringify(m.body).slice(0, 500) });
