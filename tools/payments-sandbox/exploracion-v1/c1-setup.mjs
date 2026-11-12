import crypto from 'node:crypto';
import { api, testKey, load, save, log, HOST_DEMO } from './c-lib.mjs';
const s = load();
const si = await api('/api/v1/auth/signin', {
  method: 'POST',
  body: { tenantSlug: 'demo', email: 'e2e-admin@example.test', password: 'E2eAdminPassword123!' },
});
log('signin admin demo', {
  status: si.status,
  roles: si.body?.user?.roles,
  tenantId: si.body?.user?.tenantId,
  mfa: si.body?.mfaRequired,
});
const tok = si.body.tokens.accessToken;
s.demoTenantId = si.body.user.tenantId;
log('stripe antes', (await api('/api/v1/admin/tenant-settings/stripe', { bearer: tok })).body);
// curso publicado
const stamp = Date.now();
const draft = await api('/api/v1/modules/courses', {
  method: 'POST',
  bearer: tok,
  body: {
    title: `Curso de pago (auditoria ${stamp})`,
    slug: `curso-auditoria-${stamp}`,
    description: 'Curso para probar la compra',
    category: 'general',
  },
});
const mod = await api(`/api/v1/modules/courses/${draft.body.id}/modules`, {
  method: 'POST',
  bearer: tok,
  body: { title: 'Modulo 1', orderIndex: 0 },
});
const les = await api(`/api/v1/modules/courses/modules/${mod.body.id}/lessons`, {
  method: 'POST',
  bearer: tok,
  body: {
    title: 'Leccion 1',
    type: 'TEXT',
    orderIndex: 0,
    content: { text: 'Contenido' },
    durationSec: 60,
  },
});
const pub = await api(`/api/v1/modules/courses/${draft.body.id}/publish`, {
  method: 'POST',
  bearer: tok,
});
log('curso', {
  create: draft.status,
  mod: mod.status,
  lesson: les.status,
  publish: pub.status,
  id: draft.body.id,
});
s.courseId = draft.body.id;
// CONTROL: vender sin Stripe configurado
const prod0 = await api('/api/v1/modules/billing/products', {
  method: 'POST',
  bearer: tok,
  body: { courseId: s.courseId, amountCents: 4900, currency: 'eur' },
});
log('CONTROL poner a la venta SIN Stripe', {
  status: prod0.status,
  code: prod0.body?.code,
  message: prod0.body?.message,
});
// El creador pega su clave + un secreto de webhook
s.demoWhsec = s.demoWhsec ?? 'whsec_' + crypto.randomBytes(24).toString('hex');
const put = await api('/api/v1/admin/tenant-settings/stripe', {
  method: 'PUT',
  bearer: tok,
  body: { secretKey: testKey(), webhookSecret: s.demoWhsec },
});
log('guardar credenciales', { status: put.status, body: put.body });
// CONTROL: clave inventada no pasa «Probar conexión» (en otro tenant no; aquí probamos la buena)
const test = await api('/api/v1/admin/tenant-settings/stripe/test', {
  method: 'POST',
  bearer: tok,
});
log('probar conexion', { status: test.status, body: test.body });
const prod = await api('/api/v1/modules/billing/products', {
  method: 'POST',
  bearer: tok,
  body: { courseId: s.courseId, amountCents: 4900, currency: 'eur' },
});
log('poner a la venta 49 EUR', {
  status: prod.status,
  product: prod.body?.product && {
    id: prod.body.product.id,
    stripePriceId: prod.body.product.stripePriceId,
    stripeProductId: prod.body.product.stripeProductId,
    unitAmount: prod.body.product.unitAmount,
    currency: prod.body.product.currency,
  },
  err: prod.body?.message,
});
s.productId = prod.body?.product?.id;
const offer = await api(`/api/v1/modules/billing/public/offer/${s.courseId}`, { host: HOST_DEMO });
log('oferta publica', offer.body);
const co = await api(`/api/v1/modules/billing/public/checkout/${s.courseId}`, {
  method: 'POST',
  body: { email: 'alumna-compra+auditoria@example.com' },
});
log('checkout publico', {
  status: co.status,
  sessionId: co.body?.sessionId,
  url_host: co.body?.url && new URL(co.body.url).host,
  err: co.body?.message,
});
s.sessionId = co.body?.sessionId;
s.checkoutUrl = co.body?.url;
s.adminTok = tok;
save(s);
