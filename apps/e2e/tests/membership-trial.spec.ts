/**
 * E2E de la MEMBRESÍA con PERIODO DE PRUEBA — ciclo de vida completo SIN
 * Stripe real: los webhooks se fabrican y FIRMAN aquí con el mismo secreto
 * (SUBSCRIPTIONS_WEBHOOK_SECRET) que usa el backend bajo test, replicando el
 * esquema de firma de Stripe (t=<ts>,v1=HMAC_SHA256(secret, "<ts>.<payload>")).
 * Patrón hermano de zoom-webhook-hmac.spec.ts.
 *
 * Cubre, de punta a punta (API + BD + bridges + UI):
 *  1. checkout.session.completed → sub TRIALING + grupo concedido + enrollment.
 *  2. DRIP DE TRIAL: solo las N primeras lecciones disponibles; el resto
 *     bloqueado server-side (content null + progreso 403 TRIAL_CONTENT_LOCKED).
 *  3. UI: /cuenta muestra la membresía ("En prueba" + Pagar ahora) y el player
 *     muestra el candado "Disponible cuando pase el periodo de prueba".
 *  4. FIN DE TRIAL SIN PAGO (invoice.payment_failed) → UNPAID inmediato, SIN
 *     grace → acceso revocado (enrollment CANCELLED, contenido enmascarado).
 *  5. RECOVERY (invoice.paid) → ACTIVE → acceso re-concedido COMPLETO (sin
 *     límite de trial).
 *
 * Requiere el backend arrancado con:
 *   STRIPE_SECRET_KEY=<cualquiera>  SUBSCRIPTIONS_WEBHOOK_SECRET=<E2E_STRIPE_WEBHOOK_SECRET>
 */

import { createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { API_URL, adminTokenForBootstrap, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

const WEBHOOK_SECRET = process.env.E2E_STRIPE_WEBHOOK_SECRET ?? 'whsec_e2e_local_secret';
const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'va360';

/** Firma un payload como lo haría Stripe y lo POSTea al webhook del backend. */
async function sendStripeWebhook(event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return fetch(`${API_URL}/api/v1/modules/subscriptions/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': `t=${ts},v1=${v1}`,
    },
    body: payload,
  });
}

async function api<T>(
  path: string,
  opts: { method?: string; bearer?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

interface SubRow {
  id: string;
  courseId: string | null;
  planId: string | null;
  planName?: string | null;
  status: string;
  trialEndsAt: string | null;
}

interface EnrollmentRow {
  id: string;
  courseId: string;
  status: string;
  source: string;
}

interface CourseDetailView {
  id: string;
  slug: string;
  modules: Array<{ lessons: Array<{ id: string; title: string; content: unknown }> }>;
}

test.describe('Membresía — trial completo (webhooks Stripe firmados)', () => {
  test.setTimeout(240_000);

  test('checkout → TRIALING con drip de 2 lecciones → impago revoca → pago recupera', async ({
    page,
  }) => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);

    // ── 1. Curso publicado con 3 lecciones (para gatear con límite 2) ──
    const draft = await api<{ id: string }>('/api/v1/modules/courses', {
      method: 'POST',
      bearer: adminToken,
      body: {
        title: `Curso Trial E2E ${stamp}`,
        slug: `curso-trial-e2e-${stamp}`,
        description: 'Curso para el gate de trial',
        category: 'general',
      },
    });
    expect(draft.status, 'crear curso').toBe(201);
    const mod = await api<{ id: string }>(`/api/v1/modules/courses/${draft.body.id}/modules`, {
      method: 'POST',
      bearer: adminToken,
      body: { title: 'Módulo único', orderIndex: 0 },
    });
    for (let i = 0; i < 3; i++) {
      const lesson = await api(`/api/v1/modules/courses/modules/${mod.body.id}/lessons`, {
        method: 'POST',
        bearer: adminToken,
        body: {
          title: `Lección ${i + 1}`,
          type: 'TEXT',
          orderIndex: i,
          content: { text: `Contenido real de la lección ${i + 1}.` },
          durationSec: 60,
        },
      });
      expect(lesson.status, `crear lección ${i + 1}`).toBe(201);
    }
    await api(`/api/v1/modules/courses/${draft.body.id}/publish`, {
      method: 'POST',
      bearer: adminToken,
    });
    const courseId = draft.body.id;
    const detailAdmin = await api<CourseDetailView>(`/api/v1/modules/courses/${courseId}`, {
      bearer: adminToken,
    });
    const lessonIds = detailAdmin.body.modules.flatMap((m) => m.lessons).map((l) => l.id);
    expect(lessonIds).toHaveLength(3);

    // ── 2. Grupo de acceso de la membresía con ese curso ──
    const group = await api<{ id: string }>('/api/v1/modules/access-groups', {
      method: 'POST',
      bearer: adminToken,
      body: { name: `Membresía E2E ${stamp}`, kind: 'MULTI_COURSE', courseIds: [courseId] },
    });
    expect(group.status, 'crear grupo').toBe(201);

    // ── 3. Config de membresía: activa, grupo, límite de trial = 2 + plan con prueba ──
    const cfg = await api('/api/v1/membership/admin/config', {
      method: 'PUT',
      bearer: adminToken,
      body: { active: true, accessGroupId: group.body.id, trialLessonLimit: 2 },
    });
    expect(cfg.status, 'config membresía').toBe(200);
    const plan = await api<{ id: string }>('/api/v1/membership/admin/plans', {
      method: 'POST',
      bearer: adminToken,
      body: { name: `Plan E2E ${stamp}`, intervalMonths: 1, amountCents: 990, trialDays: 7 },
    });
    expect(plan.status, 'crear plan').toBe(201);

    // ── 4. Comprador con cuenta previa (password conocida) ──
    const buyerEmail = `e2e-buyer-${stamp}@example.test`;
    const buyer = await signup({
      tenantSlug: TENANT_SLUG,
      email: buyerEmail,
      password: 'E2eTestPassword123!',
      name: 'Buyer Trial E2E',
    });
    const buyerToken = buyer.tokens.accessToken;
    const tenantId = buyer.user.tenantId;
    const stripeSubId = `sub_e2e_${stamp}`;

    // ── 5. Stripe confirma el checkout (webhook FIRMADO) ──
    const whCheckout = await sendStripeWebhook({
      id: `evt_e2e_${stamp}_checkout`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_e2e_${stamp}`,
          object: 'checkout.session',
          metadata: { membership: '1', tenantId, planId: plan.body.id },
          subscription: stripeSubId,
          customer: `cus_e2e_${stamp}`,
          customer_email: null,
          customer_details: { email: buyerEmail, name: 'Buyer Trial E2E' },
        },
      },
    });
    expect(whCheckout.status, 'webhook checkout.session.completed').toBe(200);

    // Sub local TRIALING con el nombre real del plan.
    const mySub = async () =>
      (
        await api<{ subscriptions: SubRow[] }>('/api/v1/modules/subscriptions/me', {
          bearer: buyerToken,
        })
      ).body.subscriptions.find((s) => s.planId === plan.body.id);
    await expect.poll(async () => (await mySub())?.status, { timeout: 20_000 }).toBe('TRIALING');
    const sub = (await mySub())!;
    expect(sub.courseId).toBeNull();
    expect(sub.planName).toBe(`Plan E2E ${stamp}`);
    expect(sub.trialEndsAt).not.toBeNull();

    // El bridge concedió el grupo → enrollment ACTIVE con source GROUP.
    const myEnrollment = async () =>
      (
        await api<EnrollmentRow[]>('/api/v1/modules/learning/me/enrollments', {
          bearer: buyerToken,
        })
      ).body.find((e) => e.courseId === courseId);
    await expect
      .poll(async () => (await myEnrollment())?.status, { timeout: 20_000 })
      .toBe('ACTIVE');
    const enrollment = (await myEnrollment())!;
    expect(enrollment.source).toBe('GROUP');

    // ── 6. DRIP DE TRIAL server-side ──
    const avail = await api<{
      drip: boolean;
      trial?: { lessonLimit: number };
      lessons: Record<string, { available: boolean; reason?: string; availableAt: string | null }>;
    }>(`/api/v1/modules/learning/courses/${courseId}/availability`, { bearer: buyerToken });
    expect(avail.body.trial).toEqual({ lessonLimit: 2 });
    expect(avail.body.lessons[lessonIds[0]!]).toBeUndefined(); // 1ª libre
    expect(avail.body.lessons[lessonIds[1]!]).toBeUndefined(); // 2ª libre
    expect(avail.body.lessons[lessonIds[2]!]).toMatchObject({
      available: false,
      reason: 'TRIAL',
      availableAt: null,
    });

    // El detalle del curso NO entrega el contenido de la 3ª lección.
    const detailBuyer = await api<CourseDetailView>(`/api/v1/modules/courses/${courseId}`, {
      bearer: buyerToken,
    });
    const lessonsBuyer = detailBuyer.body.modules.flatMap((m) => m.lessons);
    expect(lessonsBuyer[0]!.content).toBeTruthy();
    expect(lessonsBuyer[1]!.content).toBeTruthy();
    expect(lessonsBuyer[2]!.content).toBeNull();

    // Progreso: la 3ª lección devuelve 403 TRIAL_CONTENT_LOCKED; la 1ª pasa.
    const trackLocked = await api<{ code?: string }>('/api/v1/modules/learning/progress', {
      method: 'POST',
      bearer: buyerToken,
      body: { enrollmentId: enrollment.id, lessonId: lessonIds[2], watchedSeconds: 5 },
    });
    expect(trackLocked.status).toBe(403);
    expect(trackLocked.body.code).toBe('TRIAL_CONTENT_LOCKED');
    const trackOk = await api('/api/v1/modules/learning/progress', {
      method: 'POST',
      bearer: buyerToken,
      body: { enrollmentId: enrollment.id, lessonId: lessonIds[0], watchedSeconds: 5 },
    });
    expect(trackOk.status).toBe(200);

    // ── 7. UI: /cuenta gestiona la membresía y el player muestra el candado ──
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: buyerToken,
      refreshToken: buyer.tokens.refreshToken,
      user: {
        id: buyer.user.id,
        email: buyer.user.email,
        name: buyer.user.name,
        tenantId: buyer.user.tenantId,
        tenantSlug: buyer.user.tenantSlug,
        roles: buyer.user.roles,
        mfaEnabled: buyer.user.mfaEnabled,
        onboardingCompletedAt: new Date().toISOString(),
      },
    });
    await page.goto('/cuenta?tab=suscripcion');
    await expect(page.getByText(`Plan E2E ${stamp}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('En prueba')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pagar ahora y activar' })).toBeVisible();

    await page.goto(`/cursos/curso-trial-e2e-${stamp}`);
    // La 3ª lección lleva el candado del trial en el índice.
    await expect(page.getByText('🔒 tras la prueba')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Lección 3/ }).click();
    await expect(page.getByText('Disponible cuando pase el periodo de prueba')).toBeVisible();
    await expect(page.getByRole('button', { name: /Pagar ahora y desbloquear/ })).toBeVisible();

    // ── 8a. ORDEN REAL de Stripe: al terminar el trial llega PRIMERO un
    // customer.subscription.updated con status=active (el cobro se intenta
    // después). La sub NO debe salir de TRIALING sin evidencia de pago — si
    // no, el gate se apagaría y el impago ganaría el grace del dunning. ──
    const whUpdated = await sendStripeWebhook({
      id: `evt_e2e_${stamp}_updated_active`,
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: stripeSubId,
          object: 'subscription',
          status: 'active',
          trial_end: null,
          cancel_at_period_end: false,
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
          customer: `cus_e2e_${stamp}`,
          metadata: {},
        },
      },
    });
    expect(whUpdated.status, 'webhook updated(active) sin pago').toBe(200);
    // Sigue TRIALING y el gate sigue encendido.
    expect((await mySub())?.status).toBe('TRIALING');
    const availStillGated = await api<{ trial?: { lessonLimit: number } }>(
      `/api/v1/modules/learning/courses/${courseId}/availability`,
      { bearer: buyerToken },
    );
    expect(availStillGated.body.trial).toEqual({ lessonLimit: 2 });

    // ── 8b. FIN DE TRIAL SIN PAGO → pierde el acceso YA (sin grace) ──
    const whFail = await sendStripeWebhook({
      id: `evt_e2e_${stamp}_fail`,
      object: 'event',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: `in_e2e_${stamp}_1`,
          object: 'invoice',
          subscription: stripeSubId,
          amount_paid: 0,
          amount_due: 990,
          currency: 'eur',
          period_start: Math.floor(Date.now() / 1000),
          period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
          hosted_invoice_url: null,
          attempt_count: 1,
          next_payment_attempt: null,
        },
      },
    });
    expect(whFail.status, 'webhook invoice.payment_failed').toBe(200);

    await expect.poll(async () => (await mySub())?.status, { timeout: 20_000 }).toBe('UNPAID');
    // El bridge revocó el grupo → enrollment CANCELLED y contenido enmascarado.
    await expect
      .poll(async () => (await myEnrollment())?.status, { timeout: 20_000 })
      .toBe('CANCELLED');
    const detailRevoked = await api<CourseDetailView>(`/api/v1/modules/courses/${courseId}`, {
      bearer: buyerToken,
    });
    for (const l of detailRevoked.body.modules.flatMap((m) => m.lessons)) {
      expect(l.content, `lección ${l.title} enmascarada tras el impago`).toBeNull();
    }

    // ── 9. RECOVERY: Stripe reintenta y cobra → acceso COMPLETO de vuelta ──
    const whPaid = await sendStripeWebhook({
      id: `evt_e2e_${stamp}_paid`,
      object: 'event',
      type: 'invoice.paid',
      data: {
        object: {
          id: `in_e2e_${stamp}_1`,
          object: 'invoice',
          subscription: stripeSubId,
          amount_paid: 990,
          amount_due: 990,
          currency: 'eur',
          period_start: Math.floor(Date.now() / 1000),
          period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
          hosted_invoice_url: null,
          attempt_count: 2,
          next_payment_attempt: null,
        },
      },
    });
    expect(whPaid.status, 'webhook invoice.paid').toBe(200);

    await expect.poll(async () => (await mySub())?.status, { timeout: 20_000 }).toBe('ACTIVE');
    await expect
      .poll(async () => (await myEnrollment())?.status, { timeout: 20_000 })
      .toBe('ACTIVE');
    // Ya NO está en trial → sin límite: la 3ª lección llega con contenido.
    const availAfter = await api<{ trial?: unknown }>(
      `/api/v1/modules/learning/courses/${courseId}/availability`,
      { bearer: buyerToken },
    );
    expect(availAfter.body.trial).toBeUndefined();
    const detailAfter = await api<CourseDetailView>(`/api/v1/modules/courses/${courseId}`, {
      bearer: buyerToken,
    });
    expect(detailAfter.body.modules.flatMap((m) => m.lessons)[2]!.content).toBeTruthy();
  });
});
