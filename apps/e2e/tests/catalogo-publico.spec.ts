/**
 * E2E del VIAJE 2 PÚBLICO (F4): catálogo/oferta de cursos sueltos SIN sesión
 * y compra ANÓNIMA con provisioning post-pago.
 *
 * Sin Stripe real (patrón hermano de membership-trial.spec.ts):
 *  - El producto de venta se siembra por SQL directo contra el Postgres del
 *    stack efímero (crear productos por API exige llamar a Stripe). Fixture
 *    de test con datos neutros — nunca datos de un cliente.
 *  - El webhook `checkout.session.completed` se fabrica y FIRMA aquí con el
 *    mismo secreto (STRIPE_WEBHOOK_SECRET) que usa el backend bajo test.
 *
 * Cubre:
 *  1. Catálogo público por API sin token: curso publicado con su oferta
 *     (precio, tachado, % derivado); oferta de id no-UUID → 404.
 *  2. UI sin sesión: /catalogo pinta la tarjeta y /catalogo/[slug] la ficha
 *     con el CTA de compra (nunca redirige a /signin).
 *  3. Compra anónima: webhook firmado sobre una order PENDING sin dueño →
 *     crea la cuenta del comprador (email confirmado en Stripe), completa la
 *     order y matricula vía bridge. Reentrega idempotente.
 *  4. Fix admin: `:userId` no-UUID responde 404 (antes 500 por cast Prisma).
 *
 * Requiere el stack efímero: docker-compose.test.yml + API con
 * STRIPE_SECRET_KEY=<cualquiera> y STRIPE_WEBHOOK_SECRET=<E2E_BILLING_WEBHOOK_SECRET>.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { API_URL, adminTokenForBootstrap, createPublishedCourse } from '../helpers/api';

const WEBHOOK_SECRET = process.env.E2E_BILLING_WEBHOOK_SECRET ?? 'whsec_e2e_local_secret';
const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'demo';
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'didacta-postgres-test';
const PG_USER = process.env.E2E_PG_USER ?? 'didacta_test';
const PG_DB = process.env.E2E_PG_DB ?? 'didacta_test';

/** SQL directo contra el Postgres efímero (superuser del compose → sin RLS). */
function sql(query: string): string {
  return execFileSync(
    'docker',
    ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-t', '-A', '-c', query],
    { encoding: 'utf8' },
  ).trim();
}

/** Siembra una opción de compra activa del curso (lo que haría el admin con Stripe). */
function seedProduct(args: {
  tenantId: string;
  courseId: string;
  unitAmount: number;
  compareAtAmount?: number;
}): string {
  const id = randomUUID();
  const compare = args.compareAtAmount ?? 'NULL';
  sql(
    `INSERT INTO mod_billing_product (id, tenant_id, course_id, stripe_product_id, stripe_price_id, unit_amount, currency, compare_at_amount, updated_at)
     VALUES ('${id}', '${args.tenantId}', '${args.courseId}', 'prod_e2e_${id.slice(0, 8)}', 'price_e2e_${id.slice(0, 8)}', ${args.unitAmount}, 'eur', ${compare}, now())`,
  );
  return id;
}

/** Order PENDING SIN dueño: lo que crea el checkout público antes de ir a Stripe. */
function seedAnonymousOrder(args: {
  tenantId: string;
  productId: string;
  courseId: string;
  stripeSessionId: string;
}): string {
  const id = randomUUID();
  sql(
    `INSERT INTO mod_billing_order (id, tenant_id, user_id, product_id, course_id, stripe_session_id, currency, status, updated_at)
     VALUES ('${id}', '${args.tenantId}', NULL, '${args.productId}', '${args.courseId}', '${args.stripeSessionId}', 'eur', 'PENDING', now())`,
  );
  return id;
}

/** Firma un payload como lo haría Stripe y lo POSTea al webhook de billing. */
async function sendBillingWebhook(event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return fetch(`${API_URL}/api/v1/modules/billing/webhook`, {
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

interface CatalogResponse {
  courses: Array<{
    id: string;
    slug: string;
    title: string;
    options: Array<{
      unitAmount: number;
      compareAtAmount: number | null;
      discountPercent: number | null;
      currency: string;
    }>;
  }>;
}

function tenantId(): string {
  const id = sql(`SELECT id FROM tenant WHERE slug='${TENANT_SLUG}'`);
  expect(id, `tenant '${TENANT_SLUG}' existe`).not.toBe('');
  return id;
}

test.describe('Viaje 2 público — catálogo y compra anónima (F4)', () => {
  test.setTimeout(180_000);

  test('catálogo y oferta públicos por API, y UI sin sesión con CTA de compra', async ({
    browser,
  }) => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);
    const tid = tenantId();

    const course = await createPublishedCourse({
      bearer: adminToken,
      title: `Curso Venta Pública E2E ${stamp}`,
      slug: `curso-venta-publica-e2e-${stamp}`,
    });
    seedProduct({ tenantId: tid, courseId: course.id, unitAmount: 4900, compareAtAmount: 9900 });

    // ── Catálogo por API, SIN token ──
    const catalog = await api<CatalogResponse>('/api/v1/modules/billing/public/catalog');
    expect(catalog.status).toBe(200);
    const entry = catalog.body.courses.find((c) => c.id === course.id);
    expect(entry, 'el curso publicado con precio aparece en el catálogo público').toBeTruthy();
    expect(entry!.options[0]).toMatchObject({
      unitAmount: 4900,
      compareAtAmount: 9900,
      discountPercent: 51,
      currency: 'eur',
    });

    // ── Oferta pública del curso ──
    const offer = await api<{ forSale: boolean }>(
      `/api/v1/modules/billing/public/offer/${course.id}`,
    );
    expect(offer.status).toBe(200);
    expect(offer.body.forSale).toBe(true);

    // Un id malformado es 404 (no un 500 del cast de Prisma).
    const badOffer = await api('/api/v1/modules/billing/public/offer/no-soy-uuid');
    expect(badOffer.status).toBe(404);

    // ── UI: visitante SIN sesión ──
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto('/catalogo');
    await expect(page).toHaveURL(/\/catalogo$/); // sin redirect a /signin
    const card = page
      .getByTestId('catalogo-card')
      .filter({ hasText: `Curso Venta Pública E2E ${stamp}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText('49');
    await expect(card).toContainText('99'); // tachado

    await card.click();
    await expect(page).toHaveURL(new RegExp(`/catalogo/curso-venta-publica-e2e-${stamp}$`));
    await expect(page.getByRole('button', { name: 'Comprar ahora' })).toBeEnabled();
    await expect(page.getByText('Pago único · Acceso inmediato')).toBeVisible();
    await ctx.close();
  });

  test('compra anónima: el webhook firmado crea la cuenta, completa la order y matricula', async () => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);
    const tid = tenantId();

    const course = await createPublishedCourse({
      bearer: adminToken,
      title: `Curso Compra Anónima E2E ${stamp}`,
      slug: `curso-compra-anonima-e2e-${stamp}`,
    });
    const productId = seedProduct({ tenantId: tid, courseId: course.id, unitAmount: 2900 });
    const sessionId = `cs_e2e_${stamp}`;
    const orderId = seedAnonymousOrder({
      tenantId: tid,
      productId,
      courseId: course.id,
      stripeSessionId: sessionId,
    });

    const buyerEmail = `compradora-anonima-${stamp}@example.com`;
    const completedEvent = {
      id: `evt_e2e_completed_${stamp}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          object: 'checkout.session',
          // Metadata del checkout PÚBLICO: SIN userId — la order no tiene dueño.
          metadata: { orderId, productId, tenantId: tid, courseId: course.id },
          customer_email: null,
          customer_details: { email: buyerEmail, name: 'Compradora E2E' },
          amount_total: 2900,
          payment_intent: `pi_e2e_${stamp}`,
          status: 'complete',
        },
      },
    };

    const wh = await sendBillingWebhook(completedEvent);
    expect(wh.status, 'webhook checkout.session.completed').toBe(200);

    // La cuenta del comprador se materializó con el email confirmado en Stripe.
    const userId = sql(
      `SELECT id FROM "user" WHERE tenant_id='${tid}' AND email='${buyerEmail}' AND status='ACTIVE'`,
    );
    expect(userId, 'user provisionado tras el pago').not.toBe('');

    // La order quedó COMPLETED y con dueño.
    expect(
      sql(
        `SELECT status || '|' || COALESCE(user_id::text, '∅') FROM mod_billing_order WHERE id='${orderId}'`,
      ),
    ).toBe(`COMPLETED|${userId}`);

    // El bridge matriculó (source PURCHASE) — el evento va por outbox: poll.
    await expect
      .poll(
        () =>
          sql(
            `SELECT status || '|' || source FROM mod_learning_enrollment WHERE tenant_id='${tid}' AND user_id='${userId}' AND course_id='${course.id}'`,
          ),
        { timeout: 30_000 },
      )
      .toBe('ACTIVE|PURCHASE');

    // ── Reentrega del MISMO evento: idempotente (ni user ni matrícula duplicados) ──
    const replay = await sendBillingWebhook(completedEvent);
    expect(replay.status).toBe(200);
    expect(
      sql(`SELECT count(*) FROM "user" WHERE tenant_id='${tid}' AND email='${buyerEmail}'`),
    ).toBe('1');
    expect(
      sql(
        `SELECT count(*) FROM mod_learning_enrollment WHERE tenant_id='${tid}' AND user_id='${userId}' AND course_id='${course.id}'`,
      ),
    ).toBe('1');
  });

  test('admin: :userId que no es UUID responde 404, no 500', async () => {
    const adminToken = await adminTokenForBootstrap(TENANT_SLUG);

    const dossier = await api('/api/v1/admin/users/no-soy-uuid/dossier', { bearer: adminToken });
    expect(dossier.status).toBe(404);

    const decision = await api(
      '/api/v1/modules/member-registration/admin/requests/no-soy-uuid/decision',
      { method: 'POST', bearer: adminToken, body: { action: 'approve' } },
    );
    expect(decision.status).toBe(404);
  });
});
