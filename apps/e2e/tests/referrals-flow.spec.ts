/**
 * E2E del programa de referidos (mod.referrals) — flujo completo con webhooks
 * de Stripe FIRMADOS (sin Stripe real, patrón membership-trial):
 *
 *  1. Admin activa la membresía + el programa de referidos (30 %, sin mínimo).
 *  2. Un miembro (referidor) obtiene su enlace /unete?ref=CODE.
 *  3. Visita anónima a /unete?ref → clic registrado + código persistido.
 *  4. checkout.session.completed con referralCode en metadata → alta del
 *     comprador + atribución (bridge, vía outbox).
 *  5. invoice.paid de 9,90 € → comisión PENDING de 2,97 € (30 %).
 *  6. Reintento del webhook y AUTO-referido → no duplican ni atribuyen.
 *  7. Admin aprueba la comisión y registra la liquidación (referencia externa)
 *     → PAID, visible para el miembro.
 *  8. UI: /referidos (miembro) y /admin/referidos (admin) muestran datos reales.
 *
 * Requiere el backend con SUBSCRIPTIONS_WEBHOOK_SECRET=<E2E_STRIPE_WEBHOOK_SECRET>.
 */

import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { API_URL, adminTokenForBootstrap, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

const WEBHOOK_SECRET = process.env.E2E_STRIPE_WEBHOOK_SECRET ?? 'whsec_e2e_local_secret';
const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'va360';

async function sendStripeWebhook(event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return fetch(`${API_URL}/api/v1/modules/subscriptions/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${ts},v1=${v1}` },
    body: payload,
  });
}

async function api<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; bearer?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface MemberStats {
  programActive: boolean;
  clicks: number;
  referrals: number;
  totals: { pendingCents: number; approvedCents: number; paidCents: number };
}

test.describe('Referidos — flujo completo (webhooks Stripe firmados)', () => {
  test('enlace → clic → atribución → comisión → aprobación → liquidación', async ({ page }) => {
    test.setTimeout(240_000);
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);

    // ── 1. Membresía mínima operativa: curso + grupo + config + plan sin trial ──
    const draft = await api<{ id: string }>('/modules/courses', {
      method: 'POST',
      bearer: adminToken,
      body: {
        title: `Curso Referidos E2E ${stamp}`,
        slug: `curso-referidos-e2e-${stamp}`,
        description: 'Curso del flujo de referidos',
        category: 'general',
      },
    });
    expect(draft.status, 'crear curso').toBe(201);
    await api(`/modules/courses/${draft.body.id}/publish`, { method: 'POST', bearer: adminToken });
    const group = await api<{ id: string }>('/modules/access-groups', {
      method: 'POST',
      bearer: adminToken,
      body: {
        name: `Membresía Referidos E2E ${stamp}`,
        kind: 'MULTI_COURSE',
        courseIds: [draft.body.id],
      },
    });
    expect(group.status, 'crear grupo').toBe(201);
    const cfg = await api('/membership/admin/config', {
      method: 'PUT',
      bearer: adminToken,
      body: { active: true, accessGroupId: group.body.id, trialLessonLimit: 0 },
    });
    expect(cfg.status, 'config membresía').toBe(200);
    const plan = await api<{ id: string }>('/membership/admin/plans', {
      method: 'POST',
      bearer: adminToken,
      body: {
        name: `Plan Referidos E2E ${stamp}`,
        intervalMonths: 1,
        amountCents: 990,
        trialDays: 0,
      },
    });
    expect(plan.status, 'crear plan').toBe(201);

    // Programa de referidos: 30 %, recurrente, sin mínimo, sin exigir membresía
    // (el referidor de este spec es un alumno free).
    const refCfg = await api('/modules/referrals/admin/config', {
      method: 'PUT',
      bearer: adminToken,
      body: {
        active: true,
        commissionBps: 3000,
        scope: 'RECURRING',
        recurringMonths: null,
        attributionWindowDays: 30,
        guaranteeDays: 14,
        minPayoutCents: 0,
        requireActiveMembership: false,
      },
    });
    expect(refCfg.status, 'config referidos').toBe(200);

    // ── 2. Referidor con su enlace ──
    const referrer = await signup({
      tenantSlug: TENANT_SLUG,
      email: `e2e-referrer-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Referidor E2E',
    });
    const referrerToken = referrer.tokens.accessToken;
    const tenantId = referrer.user.tenantId;
    const me = await api<{ code: string; url: string }>('/modules/referrals/me', {
      bearer: referrerToken,
    });
    expect(me.status, 'GET /modules/referrals/me').toBe(200);
    const code = me.body.code;
    expect(code).toMatch(/^[a-z2-9]{8}$/);
    expect(me.body.url).toContain(`/unete?ref=${code}`);

    const stats = async (): Promise<MemberStats> =>
      (await api<MemberStats>('/modules/referrals/me/stats', { bearer: referrerToken })).body;

    // ── 3. Visita anónima a /unete?ref=CODE: clic + persistencia client-side ──
    await page.goto(`/unete?ref=${code}`);
    await expect
      .poll(async () => (await stats()).clicks, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);
    const stored = await page.evaluate(() => window.localStorage.getItem('didacta.referral'));
    expect(stored, 'código persistido en localStorage').toContain(code);

    // ── 4. Checkout completado CON referralCode en metadata → atribución ──
    const buyerEmail = `e2e-ref-buyer-${stamp}@example.test`;
    const stripeSubId = `sub_e2e_ref_${stamp}`;
    const whCheckout = await sendStripeWebhook({
      id: `evt_e2e_ref_${stamp}_checkout`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_e2e_ref_${stamp}`,
          object: 'checkout.session',
          metadata: { membership: '1', tenantId, planId: plan.body.id, referralCode: code },
          subscription: stripeSubId,
          customer: `cus_e2e_ref_${stamp}`,
          customer_email: null,
          customer_details: { email: buyerEmail, name: 'Comprador Referido E2E' },
        },
      },
    });
    expect(whCheckout.status, 'webhook checkout.session.completed').toBe(200);
    await expect.poll(async () => (await stats()).referrals, { timeout: 20_000 }).toBe(1);

    // Reintento del mismo checkout (nuevo event id, misma sub) → idempotente.
    await sendStripeWebhook({
      id: `evt_e2e_ref_${stamp}_checkout_retry`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_e2e_ref_${stamp}`,
          object: 'checkout.session',
          metadata: { membership: '1', tenantId, planId: plan.body.id, referralCode: code },
          subscription: stripeSubId,
          customer: `cus_e2e_ref_${stamp}`,
          customer_email: null,
          customer_details: { email: buyerEmail, name: 'Comprador Referido E2E' },
        },
      },
    });
    expect((await stats()).referrals, 'reintento no duplica atribución').toBe(1);

    // AUTO-referido: el propio referidor "compra" con su código → denegado.
    await sendStripeWebhook({
      id: `evt_e2e_ref_${stamp}_self`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_e2e_ref_${stamp}_self`,
          object: 'checkout.session',
          metadata: { membership: '1', tenantId, planId: plan.body.id, referralCode: code },
          subscription: `sub_e2e_ref_${stamp}_self`,
          customer: `cus_e2e_ref_${stamp}_self`,
          customer_email: null,
          customer_details: { email: referrer.user.email, name: 'Referidor E2E' },
        },
      },
    });
    // Damos margen al outbox y verificamos que NO se atribuyó.
    await page.waitForTimeout(3_000);
    expect((await stats()).referrals, 'auto-referido no atribuye').toBe(1);

    // ── 5. Cobro real → comisión PENDING del 30 % (990 → 297) ──
    const whPaid = await sendStripeWebhook({
      id: `evt_e2e_ref_${stamp}_paid`,
      object: 'event',
      type: 'invoice.paid',
      data: {
        object: {
          id: `in_e2e_ref_${stamp}`,
          object: 'invoice',
          subscription: stripeSubId,
          amount_paid: 990,
          amount_due: 990,
          currency: 'eur',
          billing_reason: 'subscription_cycle',
          period_start: Math.floor(Date.now() / 1000),
          period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
          hosted_invoice_url: null,
          attempt_count: 1,
          next_payment_attempt: null,
        },
      },
    });
    expect(whPaid.status, 'webhook invoice.paid').toBe(200);
    await expect
      .poll(async () => (await stats()).totals.pendingCents, { timeout: 20_000 })
      .toBe(297);

    // ── 6. Admin: aprobar ya + liquidar con referencia externa ──
    const pendingList = await api<{
      commissions: Array<{ id: string; status: string; amountCents: number }>;
    }>('/modules/referrals/admin/commissions?status=PENDING', { bearer: adminToken });
    const commission = pendingList.body.commissions.find((c) => c.amountCents === 297);
    expect(commission, 'comisión PENDING visible para el admin').toBeTruthy();
    const approve = await api(`/modules/referrals/admin/commissions/${commission!.id}/approve`, {
      method: 'POST',
      bearer: adminToken,
    });
    expect(approve.status, 'aprobar comisión').toBe(200);
    await expect
      .poll(async () => (await stats()).totals.approvedCents, { timeout: 10_000 })
      .toBe(297);

    const payout = await api<{ totalCents: number }>('/modules/referrals/admin/payouts', {
      method: 'POST',
      bearer: adminToken,
      body: {
        referrerUserId: referrer.user.id,
        commissionIds: [commission!.id],
        externalReference: `Transferencia E2E ${stamp}`,
      },
    });
    expect(payout.status, 'registrar liquidación').toBe(201);
    expect(payout.body.totalCents).toBe(297);
    await expect.poll(async () => (await stats()).totals.paidCents, { timeout: 10_000 }).toBe(297);

    // ── 7. UI del miembro: /referidos con enlace, altas y pagado ──
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: referrerToken,
      refreshToken: referrer.tokens.refreshToken,
      user: {
        id: referrer.user.id,
        email: referrer.user.email,
        name: referrer.user.name,
        tenantId: referrer.user.tenantId,
        tenantSlug: referrer.user.tenantSlug,
        roles: referrer.user.roles,
        mfaEnabled: referrer.user.mfaEnabled,
        onboardingCompletedAt: new Date().toISOString(),
      },
    });
    await page.goto('/referidos');
    await expect(page.getByRole('heading', { name: 'Referidos' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('referral-link-input')).toHaveValue(new RegExp(code), {
      timeout: 15_000,
    });
    await expect(page.getByTestId('referral-stats').getByText('Altas atribuidas')).toBeVisible();
    // El importe pagado (2,97 €) aparece en el tile "Pagado hasta hoy", en la
    // comisión y en la liquidación — basta con que sea visible.
    await expect(page.getByText('2,97').first()).toBeVisible();
    // Botón promo dorado de la cabecera: solo con el programa activo y con
    // el % REAL de la config (30% en este spec).
    await expect(page.getByTestId('referrals-promo-button')).toBeVisible();
    await expect(page.getByTestId('referrals-promo-button')).toHaveText('Plan de Referidos 30%');

    // ── 8. UI del admin: /admin/referidos con config y ranking ──
    const adminSession = await (async () => {
      const { signin } = await import('../helpers/api');
      return signin({
        tenantSlug: TENANT_SLUG,
        email: process.env.E2E_ADMIN_EMAIL!,
        password: process.env.E2E_ADMIN_PASSWORD!,
      });
    })();
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: adminToken,
      user: {
        id: adminSession.user.id,
        email: adminSession.user.email,
        name: 'Admin E2E',
        tenantId: adminSession.user.tenantId,
        tenantSlug: TENANT_SLUG,
        roles: adminSession.user.roles,
        mfaEnabled: true,
        onboardingCompletedAt: new Date().toISOString(),
      },
    });
    await page.goto('/admin/referidos');
    await expect(page.getByRole('heading', { name: 'Programa de referidos' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('referrals-config-card')).toBeVisible();
    await expect(
      page.getByTestId('referrals-referrers-card').getByText(code, { exact: true }),
    ).toBeVisible();
  });

  test('un reembolso (charge.refunded) revoca la comisión pendiente', async () => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);

    // Reusa la config del programa y el plan del test anterior no — plan propio
    // para no depender del orden más allá de la config global del tenant.
    const plan = await api<{ id: string }>('/membership/admin/plans', {
      method: 'POST',
      bearer: adminToken,
      body: { name: `Plan Refund E2E ${stamp}`, intervalMonths: 1, amountCents: 990, trialDays: 0 },
    });
    expect(plan.status, 'crear plan').toBe(201);

    const referrer = await signup({
      tenantSlug: TENANT_SLUG,
      email: `e2e-refunder-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Referidor Refund E2E',
    });
    const referrerToken = referrer.tokens.accessToken;
    const tenantId = referrer.user.tenantId;
    const me = await api<{ code: string }>('/modules/referrals/me', { bearer: referrerToken });
    expect(me.status).toBe(200);
    const code = me.body.code;

    const stats = async (): Promise<MemberStats> =>
      (await api<MemberStats>('/modules/referrals/me/stats', { bearer: referrerToken })).body;

    // Alta atribuida + cobro → comisión PENDING de 297.
    const stripeSubId = `sub_e2e_refund_${stamp}`;
    await sendStripeWebhook({
      id: `evt_e2e_refund_${stamp}_checkout`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_e2e_refund_${stamp}`,
          object: 'checkout.session',
          metadata: { membership: '1', tenantId, planId: plan.body.id, referralCode: code },
          subscription: stripeSubId,
          customer: `cus_e2e_refund_${stamp}`,
          customer_email: null,
          customer_details: { email: `e2e-refund-buyer-${stamp}@example.test`, name: 'Buyer' },
        },
      },
    });
    await expect.poll(async () => (await stats()).referrals, { timeout: 20_000 }).toBe(1);
    const invoiceId = `in_e2e_refund_${stamp}`;
    await sendStripeWebhook({
      id: `evt_e2e_refund_${stamp}_paid`,
      object: 'event',
      type: 'invoice.paid',
      data: {
        object: {
          id: invoiceId,
          object: 'invoice',
          subscription: stripeSubId,
          amount_paid: 990,
          amount_due: 990,
          currency: 'eur',
          billing_reason: 'subscription_cycle',
          period_start: Math.floor(Date.now() / 1000),
          period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
          hosted_invoice_url: null,
          attempt_count: 1,
          next_payment_attempt: null,
        },
      },
    });
    await expect
      .poll(async () => (await stats()).totals.pendingCents, { timeout: 20_000 })
      .toBe(297);

    // Reembolso del cargo → la comisión PENDING queda revocada automáticamente.
    const whRefund = await sendStripeWebhook({
      id: `evt_e2e_refund_${stamp}_refunded`,
      object: 'event',
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_e2e_refund_${stamp}`,
          object: 'charge',
          invoice: invoiceId,
          amount_refunded: 990,
          currency: 'eur',
          refunded: true,
        },
      },
    });
    expect(whRefund.status, 'webhook charge.refunded').toBe(200);
    await expect.poll(async () => (await stats()).totals.pendingCents, { timeout: 20_000 }).toBe(0);
    const commissions = await api<{
      commissions: Array<{ status: string; revokeReason?: string }>;
    }>('/modules/referrals/admin/commissions?status=REVOKED', { bearer: adminToken });
    expect(
      commissions.body.commissions.some((c) => c.revokeReason === 'Reembolso del cobro en Stripe'),
      'comisión revocada con motivo de reembolso',
    ).toBe(true);
  });
});
