import { api, load, save, log } from './c-lib.mjs';
const s = load();
const tok = s.adminTok;
const plan = await api('/api/v1/membership/admin/plans', {
  method: 'POST',
  bearer: tok,
  body: { name: 'Mensual (auditoria)', intervalMonths: 1, amountCents: 2900, currency: 'eur' },
});
log('crear plan', {
  status: plan.status,
  body: plan.body && JSON.stringify(plan.body).slice(0, 400),
});
const cfg = await api('/api/v1/membership/admin/config', {
  method: 'PUT',
  bearer: tok,
  body: { active: true, headline: 'Membresia de prueba' },
});
log('activar membresia', {
  status: cfg.status,
  body: cfg.body && JSON.stringify(cfg.body).slice(0, 300),
});
const page = await api('/api/v1/membership/page');
log('pagina publica', { status: page.status, body: JSON.stringify(page.body).slice(0, 600) });
const planId = plan.body?.plan?.id ?? plan.body?.id ?? page.body?.plans?.[0]?.id;
s.planId = planId;
const co = await api('/api/v1/membership/checkout', {
  method: 'POST',
  body: { planId, email: 'socia+auditoria@example.com' },
});
log('checkout membresia', {
  status: co.status,
  sessionId: co.body?.sessionId,
  err: co.body?.message,
});
s.subSessionId = co.body?.sessionId;
s.subCheckoutUrl = co.body?.url;
save(s);
