/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * SubscriptionsService — lógica de dominio de mod.subscriptions.
 *
 * Diseño (paralelo a mod.billing):
 *   - Stateless: persistencia en Prisma (tablas mod_subscriptions_*).
 *   - Stripe inyectado vía adapter (mockeable).
 *   - Eventos publicados vía SubscriptionsEventPublisher inyectado.
 *   - Idempotencia del webhook: tabla mod_subscriptions_webhook_event con
 *     PK natural stripe_event_id. Antes de procesar, intentamos crearlo;
 *     si choca, skip silencioso.
 *
 * Lo que NO hace este service:
 *   - Enrollar al alumno: lo hace mod.learning escuchando
 *     `subscriptions.subscription.activated`.
 *   - Pausar/desenrolar: lo hace mod.learning escuchando
 *     `subscriptions.subscription.unpaid` y `.canceled`.
 *   - Cron de grace expiration: lo hace un job en apps/api que invoca
 *     `expireGracePeriods()` de este service.
 *   - Validación de input: lo hace el controller con zod.
 *
 * Estados de suscripción:
 *   PENDING → checkout creado, esperando confirmación Stripe.
 *   ACTIVE → invoice del periodo actual pagada.
 *   PAST_DUE → invoice falló, en grace period (sigue con acceso).
 *   UNPAID → grace expirado sin pago, sin acceso (bridge pausa enrollment).
 *   CANCELED → cancelada definitivamente.
 *
 * Transiciones legales:
 *   PENDING → ACTIVE (subscription.created event)
 *   PENDING → CANCELED (checkout abandonado, expira sub en Stripe)
 *   ACTIVE → PAST_DUE (invoice.payment_failed)
 *   ACTIVE → CANCELED (cancelSubscription o subscription.deleted webhook)
 *   PAST_DUE → ACTIVE (invoice.paid recovery)
 *   PAST_DUE → UNPAID (gracePeriodEndsAt expirado, expireGracePeriods cron)
 *   UNPAID → ACTIVE (alumno actualiza método de pago, invoice.paid recovery)
 *   UNPAID → CANCELED (Stripe declara invoice como uncollectible)
 */

import type { PrismaClient } from '@didacta/database';
import type Stripe from 'stripe';
import {
  SubscriptionAccessDeniedError,
  SubscriptionNotFoundError,
  SubscriptionAlreadyActiveError,
  SubscriptionPriceNotRecurringError,
  StripeApiError,
} from './errors.js';
import type { SubscriptionsStripeAdapter } from './stripe-subscriptions.client.js';

/** Resuelve el SubscriptionsStripeAdapter a usar para un tenant concreto, por llamada. */
export type SubscriptionsStripeAdapterResolver = (
  tenantId: string,
) => Promise<SubscriptionsStripeAdapter>;

type SubscriptionRow = Awaited<ReturnType<PrismaClient['modSubscriptionsSubscription']['create']>>;
type InvoiceRow = Awaited<ReturnType<PrismaClient['modSubscriptionsInvoice']['create']>>;

export interface SubscriptionsEventPublisher {
  publish(
    tenantId: string,
    actorId: string | null,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export interface CheckoutUrlBuilder {
  successUrl(courseId: string): string;
  cancelUrl(courseId: string): string;
}

export interface StartSubscriptionInput {
  tenantId: string;
  userId: string;
  userEmail: string;
  courseId: string;
  /** Stripe Price ID recurring. El admin lo configura por curso. */
  stripePriceId: string;
}

export interface StartSubscriptionResult {
  subscriptionId: string;
  sessionId: string;
  url: string;
}

const EVENT = {
  CREATED: 'subscriptions.subscription.created',
  ACTIVATED: 'subscriptions.subscription.activated',
  PAST_DUE: 'subscriptions.subscription.past_due',
  UNPAID: 'subscriptions.subscription.unpaid',
  CANCELED: 'subscriptions.subscription.canceled',
  INVOICE_PAID: 'subscriptions.invoice.paid',
  INVOICE_FAILED: 'subscriptions.invoice.payment_failed',
  INVOICE_REFUNDED: 'subscriptions.invoice.refunded',
} as const;

/**
 * Default 3 días desde el primer fallo de pago hasta que la sub queda UNPAID.
 * Stripe reintenta en sus propios intervalos (por defecto 1, 3, 5, 7 días).
 * 3 días cubre un fin de semana sin acceder a la cuenta + fallo transitorio.
 * Configurable vía env `SUBSCRIPTIONS_GRACE_PERIOD_DAYS`.
 */
export const DEFAULT_GRACE_PERIOD_DAYS = 3;

export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly stripeFor: SubscriptionsStripeAdapterResolver,
    private readonly publisher: SubscriptionsEventPublisher,
    private readonly urls: CheckoutUrlBuilder,
    private readonly gracePeriodDays: number = DEFAULT_GRACE_PERIOD_DAYS,
  ) {}

  // ---------------- Checkout (alumno) ----------------

  /**
   * Inicia una suscripción nueva. Crea row PENDING local + Stripe Checkout
   * Session en mode='subscription'. La activación efectiva llega vía webhook
   * (customer.subscription.created → status=trialing/active).
   */
  async startSubscription(input: StartSubscriptionInput): Promise<StartSubscriptionResult> {
    const stripe = await this.stripeFor(input.tenantId);
    // Validación: el price debe ser recurring antes de crear nada local.
    const price = await stripe.retrievePrice(input.stripePriceId);
    if (!price.active) {
      throw new StripeApiError(`El price ${input.stripePriceId} está inactivo en Stripe.`);
    }
    if (!price.recurringInterval) {
      throw new SubscriptionPriceNotRecurringError(input.stripePriceId);
    }

    // Una sub PENDING/TRIALING/ACTIVE/PAST_DUE por (tenant,user,course) máximo.
    const existing = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: {
        tenantId: input.tenantId,
        userId: input.userId,
        courseId: input.courseId,
        status: { in: ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE'] },
      },
    });
    if (existing) {
      throw new SubscriptionAlreadyActiveError(input.courseId);
    }

    // Customer ID: lo recibimos en el webhook customer.subscription.created.
    // Inicialmente vacío — se actualiza al primer evento.
    const sub = await this.prisma.modSubscriptionsSubscription.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        courseId: input.courseId,
        stripeCustomerId: '',
        stripePriceId: price.id,
        status: 'PENDING',
        unitAmount: price.unitAmount,
        currency: price.currency,
        interval: price.recurringInterval,
      },
    });

    let session;
    try {
      session = await stripe.createCheckoutSession({
        priceId: price.id,
        successUrl: this.urls.successUrl(input.courseId),
        cancelUrl: this.urls.cancelUrl(input.courseId),
        customerEmail: input.userEmail,
        metadata: {
          tenantId: input.tenantId,
          userId: input.userId,
          courseId: input.courseId,
          subscriptionLocalId: sub.id,
        },
      });
    } catch (err) {
      // Stripe falló — limpiamos el row local. Si dejamos PENDING colgada,
      // un futuro startSubscription la consideraría como existente.
      await this.prisma.modSubscriptionsSubscription.delete({ where: { id: sub.id } });
      throw err;
    }

    await this.publisher.publish(input.tenantId, input.userId, EVENT.CREATED, {
      subscriptionId: sub.id,
      courseId: input.courseId,
      userId: input.userId,
      stripeSessionId: session.id,
      priceId: price.id,
      interval: price.recurringInterval,
    });

    return { subscriptionId: sub.id, sessionId: session.id, url: session.url };
  }

  // ---------------- Cancelación (alumno) ----------------

  /**
   * Cancela una suscripción. Por defecto al final del periodo (el alumno
   * mantiene acceso hasta currentPeriodEnd). Pasando immediate=true se cancela
   * ya y se desenrolla — solo admins lo deberían usar.
   */
  async cancelSubscription(
    tenantId: string,
    userId: string,
    subscriptionId: string,
    options: { immediate?: boolean; actorIsAdmin?: boolean } = {},
  ): Promise<SubscriptionRow> {
    const sub = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: { id: subscriptionId, tenantId },
    });
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);
    if (sub.userId !== userId && !options.actorIsAdmin) {
      throw new SubscriptionAccessDeniedError();
    }
    if (sub.status === 'CANCELED') {
      return sub;
    }
    if (!sub.stripeSubscriptionId) {
      // Sub PENDING que aún no recibió webhook de creación. La marcamos
      // CANCELED localmente; si llega el webhook después, lo ignoraremos.
      const updated = await this.prisma.modSubscriptionsSubscription.update({
        where: { id: sub.id },
        data: {
          status: 'CANCELED',
          canceledAt: new Date(),
          canceledReason: options.actorIsAdmin ? 'admin' : 'user_request',
        },
      });
      await this.publisher.publish(tenantId, userId, EVENT.CANCELED, {
        subscriptionId: sub.id,
        courseId: sub.courseId,
        planId: sub.planId,
        userId: sub.userId,
        immediate: true,
      });
      return updated;
    }

    const atPeriodEnd = !options.immediate;
    const stripe = await this.stripeFor(tenantId);
    const stripeView = await stripe.cancelSubscription(sub.stripeSubscriptionId, atPeriodEnd);

    const updated = await this.prisma.modSubscriptionsSubscription.update({
      where: { id: sub.id },
      data: atPeriodEnd
        ? {
            cancelAtPeriodEnd: true,
            currentPeriodEnd: stripeView.currentPeriodEnd
              ? new Date(stripeView.currentPeriodEnd * 1000)
              : sub.currentPeriodEnd,
          }
        : {
            status: 'CANCELED',
            canceledAt: new Date(),
            canceledReason: options.actorIsAdmin ? 'admin' : 'user_request',
            cancelAtPeriodEnd: false,
          },
    });

    if (!atPeriodEnd) {
      await this.publisher.publish(tenantId, userId, EVENT.CANCELED, {
        subscriptionId: sub.id,
        courseId: sub.courseId,
        planId: sub.planId,
        userId: sub.userId,
        immediate: true,
      });
    }

    return updated;
  }

  // ---------------- Listado alumno ----------------

  async listMine(tenantId: string, userId: string): Promise<SubscriptionRow[]> {
    return this.prisma.modSubscriptionsSubscription.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listInvoicesForSubscription(
    tenantId: string,
    subscriptionId: string,
  ): Promise<InvoiceRow[]> {
    return this.prisma.modSubscriptionsInvoice.findMany({
      where: { tenantId, subscriptionId },
      orderBy: { periodStart: 'desc' },
    });
  }

  // ---------------- Webhook handler (idempotente) ----------------

  /**
   * Resuelve el tenant dueño de un evento webhook SIN procesarlo. Mitad
   * «lookup» del patrón F3: el host la invoca bajo acceso global sancionado y
   * después ejecuta `handleWebhookEvent` bajo el contexto del tenant resuelto.
   * Devuelve null si la entidad no existe localmente o el evento no tiene
   * lógica de dominio (el host lo procesa sancionado: solo se archiva).
   */
  async resolveWebhookTenantId(event: Stripe.Event): Promise<string | null> {
    switch (event.type) {
      case 'customer.subscription.created': {
        const localId = this.extractLocalId(event.data.object as Stripe.Subscription);
        if (!localId) return null;
        const sub = await this.prisma.modSubscriptionsSubscription.findUnique({
          where: { id: localId },
          select: { tenantId: true },
        });
        return sub?.tenantId ?? null;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const stripeSub = event.data.object as Stripe.Subscription;
        const sub = await this.prisma.modSubscriptionsSubscription.findUnique({
          where: { stripeSubscriptionId: stripeSub.id },
          select: { tenantId: true },
        });
        return sub?.tenantId ?? null;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        if (!invoice.subscription) return null;
        const stripeSubId =
          typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id;
        const sub = await this.prisma.modSubscriptionsSubscription.findUnique({
          where: { stripeSubscriptionId: stripeSubId },
          select: { tenantId: true },
        });
        return sub?.tenantId ?? null;
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const stripeInvoiceId =
          typeof charge.invoice === 'string' ? charge.invoice : (charge.invoice?.id ?? null);
        if (!stripeInvoiceId) return null;
        const invoice = await this.prisma.modSubscriptionsInvoice.findUnique({
          where: { stripeInvoiceId },
          select: { tenantId: true },
        });
        return invoice?.tenantId ?? null;
      }
      default:
        return null;
    }
  }

  /**
   * Procesa un evento Stripe ya validado por firma. Idempotente.
   */
  async handleWebhookEvent(event: Stripe.Event, rawPayload: unknown): Promise<void> {
    try {
      await this.prisma.modSubscriptionsWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          payload: rawPayload as never,
        },
      });
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (
        message.includes('Unique constraint') ||
        message.includes('mod_subscriptions_webhook_event')
      ) {
        return;
      }
      throw err;
    }

    try {
      switch (event.type) {
        case 'customer.subscription.created':
          await this.onSubscriptionCreated(event.data.object as Stripe.Subscription);
          break;
        case 'customer.subscription.updated':
          await this.onSubscriptionUpdated(event.data.object as Stripe.Subscription);
          break;
        case 'customer.subscription.deleted':
          await this.onSubscriptionDeleted(event.data.object as Stripe.Subscription);
          break;
        case 'invoice.paid':
          await this.onInvoicePaid(event.data.object as Stripe.Invoice);
          break;
        case 'invoice.payment_failed':
          await this.onInvoicePaymentFailed(event.data.object as Stripe.Invoice);
          break;
        case 'charge.refunded':
          await this.onChargeRefunded(event.data.object as Stripe.Charge);
          break;
        default:
          // Otros eventos (invoice.created, etc.) los persistimos para audit
          // pero no tienen lógica de dominio asociada en MVP.
          break;
      }
      await this.prisma.modSubscriptionsWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { processedAt: new Date() },
      });
    } catch (err) {
      await this.prisma.modSubscriptionsWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { errorMessage: (err as Error).message },
      });
      throw err;
    }
  }

  // ---------------- Cron: expirar grace periods ----------------

  /**
   * Mitad «sweep» del barrido de grace periods (patrón F3): tenants con al
   * menos una sub PAST_DUE cuyo grace venció. El worker la invoca bajo acceso
   * global sancionado y después procesa cada tenant con su contexto RLS.
   */
  async findTenantsWithExpiredGrace(now: Date = new Date()): Promise<string[]> {
    const rows = await this.prisma.modSubscriptionsSubscription.findMany({
      where: { status: 'PAST_DUE', gracePeriodEndsAt: { lte: now } },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    return [...new Set(rows.map((r) => r.tenantId))];
  }

  /**
   * Mitad «procesado» (por tenant): marca UNPAID las subs del tenant en
   * PAST_DUE con grace vencido y emite `subscriptions.subscription.unpaid`
   * por cada una. El bridge mod.learning escucha y pausa el enrollment.
   * Devuelve las subs procesadas (para logging).
   */
  async expireGracePeriodsForTenant(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<SubscriptionRow[]> {
    const expired = await this.prisma.modSubscriptionsSubscription.findMany({
      where: {
        tenantId,
        status: 'PAST_DUE',
        gracePeriodEndsAt: { lte: now },
      },
    });
    for (const sub of expired) {
      await this.prisma.modSubscriptionsSubscription.update({
        where: { id: sub.id },
        data: { status: 'UNPAID' },
      });
      await this.publisher.publish(sub.tenantId, null, EVENT.UNPAID, {
        subscriptionId: sub.id,
        courseId: sub.courseId,
        planId: sub.planId,
        userId: sub.userId,
      });
    }
    return expired;
  }

  /**
   * Barrido global: composición sweep + por-tenant. La conserva la API del
   * módulo (tests, llamadas in-process sin contexto); el worker BullMQ usa
   * las dos mitades por separado para escopar el procesado por tenant.
   */
  async expireGracePeriods(): Promise<SubscriptionRow[]> {
    const now = new Date();
    const tenants = await this.findTenantsWithExpiredGrace(now);
    const processed: SubscriptionRow[] = [];
    for (const tenantId of tenants) {
      processed.push(...(await this.expireGracePeriodsForTenant(tenantId, now)));
    }
    return processed;
  }

  // ---------------- Webhook event handlers (privados) ----------------

  private async onSubscriptionCreated(stripeSub: Stripe.Subscription): Promise<void> {
    const localId = this.extractLocalId(stripeSub);
    if (!localId) return;
    const sub = await this.prisma.modSubscriptionsSubscription.findUnique({
      where: { id: localId },
    });
    if (!sub) return;
    if (sub.status === 'CANCELED') {
      // El alumno canceló entre que abrió el checkout y se confirmó Stripe.
      // Cancelamos en Stripe sin esperar al evento `deleted`.
      const stripe = await this.stripeFor(sub.tenantId);
      await stripe.cancelSubscription(stripeSub.id, false).catch(() => {
        // ignore — Stripe ya devolverá el deleted event
      });
      return;
    }

    const status = mapStripeStatus(stripeSub.status);
    const updated = await this.prisma.modSubscriptionsSubscription.update({
      where: { id: sub.id },
      data: {
        stripeSubscriptionId: stripeSub.id,
        stripeCustomerId:
          typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id,
        status,
        currentPeriodEnd: stripeSub.current_period_end
          ? new Date(stripeSub.current_period_end * 1000)
          : null,
        trialEndsAt: stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : null,
      },
    });

    // TRIALING también activa la entrega (el alumno tiene acceso durante la
    // prueba; el LÍMITE de contenido lo aplica mod.learning por su cuenta).
    if (status === 'ACTIVE' || status === 'TRIALING') {
      await this.publisher.publish(sub.tenantId, sub.userId, EVENT.ACTIVATED, {
        subscriptionId: sub.id,
        courseId: sub.courseId,
        planId: sub.planId,
        userId: sub.userId,
        currentPeriodEnd: updated.currentPeriodEnd,
      });
    }
  }

  private async onSubscriptionUpdated(stripeSub: Stripe.Subscription): Promise<void> {
    const sub = await this.prisma.modSubscriptionsSubscription.findUnique({
      where: { stripeSubscriptionId: stripeSub.id },
    });
    if (!sub) return;

    let newStatus = mapStripeStatus(stripeSub.status);

    // ⚠️ ORDEN REAL DE STRIPE al terminar un trial: la sub transiciona
    // trialing→active ANTES de intentar el primer cobro (la invoice de ciclo
    // se finaliza y cobra después). Si aceptáramos ese ACTIVE a ciegas, el
    // trial impagado escaparía del gate de contenido y ganaría a la vez el
    // grace period del dunning normal — acceso completo sin haber pagado.
    // Regla: una fila TRIALING solo sale de TRIALING vía `updated` si hay
    // EVIDENCIA DE PAGO (invoice local PAID con importe > 0). Las transiciones
    // legítimas las hacen onInvoicePaid (cobro OK → ACTIVE) y payNow; el
    // impago la resuelve onInvoicePaymentFailed (TRIALING → UNPAID directo).
    // CANCELED sí pasa siempre (cancelar durante la prueba es legítimo).
    if (
      sub.status === 'TRIALING' &&
      (newStatus === 'ACTIVE' || newStatus === 'PAST_DUE' || newStatus === 'UNPAID')
    ) {
      const paidInvoice = await this.prisma.modSubscriptionsInvoice.findFirst({
        where: { subscriptionId: sub.id, status: 'PAID', amount: { gt: 0 } },
        select: { id: true },
      });
      if (!paidInvoice) newStatus = 'TRIALING';
    }

    const data: Record<string, unknown> = {
      status: newStatus,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      currentPeriodEnd: stripeSub.current_period_end
        ? new Date(stripeSub.current_period_end * 1000)
        : null,
    };
    if (newStatus === 'TRIALING') {
      // Conservamos trialEndsAt existente si Stripe ya lo puso a null (trial
      // técnicamente terminado pero aún sin evidencia de cobro).
      data['trialEndsAt'] = stripeSub.trial_end
        ? new Date(stripeSub.trial_end * 1000)
        : sub.trialEndsAt;
    } else {
      data['trialEndsAt'] = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : null;
    }
    if (newStatus === 'ACTIVE') {
      data['gracePeriodEndsAt'] = null;
      data['trialEndsAt'] = null;
    }
    await this.prisma.modSubscriptionsSubscription.update({
      where: { id: sub.id },
      data,
    });

    // Recovery: si la sub estaba PAST_DUE/UNPAID y vuelve a ACTIVE → notificar.
    if ((sub.status === 'PAST_DUE' || sub.status === 'UNPAID') && newStatus === 'ACTIVE') {
      await this.publisher.publish(sub.tenantId, sub.userId, EVENT.ACTIVATED, {
        subscriptionId: sub.id,
        courseId: sub.courseId,
        planId: sub.planId,
        userId: sub.userId,
        currentPeriodEnd: data['currentPeriodEnd'],
        recovery: true,
      });
    }

    // Endurecimiento de transiciones: si Stripe mueve la sub a UNPAID/CANCELED
    // directamente vía `updated` (sin pasar por invoice.payment_failed ni
    // `deleted`), los bridges deben enterarse igual o el acceso quedaría
    // concedido con la sub muerta. El outbox dedupe por idempotencyKey
    // (`evento:subId`) absorbe el caso de doble publicación con el cron/deleted.
    if (sub.status !== newStatus && newStatus === 'UNPAID') {
      await this.publisher.publish(sub.tenantId, sub.userId, EVENT.UNPAID, {
        subscriptionId: sub.id,
        courseId: sub.courseId,
        planId: sub.planId,
        userId: sub.userId,
      });
    }
    if (sub.status !== newStatus && newStatus === 'CANCELED') {
      await this.prisma.modSubscriptionsSubscription.update({
        where: { id: sub.id },
        data: { canceledAt: new Date(), canceledReason: sub.canceledReason ?? 'stripe_updated' },
      });
      await this.publisher.publish(sub.tenantId, sub.userId, EVENT.CANCELED, {
        subscriptionId: sub.id,
        courseId: sub.courseId,
        planId: sub.planId,
        userId: sub.userId,
        immediate: true,
      });
    }
  }

  private async onSubscriptionDeleted(stripeSub: Stripe.Subscription): Promise<void> {
    const sub = await this.prisma.modSubscriptionsSubscription.findUnique({
      where: { stripeSubscriptionId: stripeSub.id },
    });
    if (!sub) return;
    if (sub.status === 'CANCELED') return;

    await this.prisma.modSubscriptionsSubscription.update({
      where: { id: sub.id },
      data: {
        status: 'CANCELED',
        canceledAt: new Date(),
        canceledReason: sub.canceledReason ?? 'stripe_deleted',
      },
    });
    await this.publisher.publish(sub.tenantId, sub.userId, EVENT.CANCELED, {
      subscriptionId: sub.id,
      courseId: sub.courseId,
      planId: sub.planId,
      userId: sub.userId,
      immediate: true,
    });
  }

  private async onInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.subscription) return;
    const stripeSubId =
      typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id;
    const sub = await this.prisma.modSubscriptionsSubscription.findUnique({
      where: { stripeSubscriptionId: stripeSubId },
    });
    if (!sub) return;

    await this.upsertInvoice(sub.id, sub.tenantId, invoice, 'PAID');

    // Recovery: si estaba PAST_DUE/UNPAID, esto la pone en ACTIVE.
    if (sub.status === 'PAST_DUE' || sub.status === 'UNPAID') {
      await this.prisma.modSubscriptionsSubscription.update({
        where: { id: sub.id },
        data: { status: 'ACTIVE', gracePeriodEndsAt: null, trialEndsAt: null },
      });
      await this.publisher.publish(sub.tenantId, sub.userId, EVENT.ACTIVATED, {
        subscriptionId: sub.id,
        courseId: sub.courseId,
        planId: sub.planId,
        userId: sub.userId,
        recovery: true,
      });
    }

    // Fin de trial pagado: la invoice de CICLO cobrada cierra la prueba y la
    // sub pasa a ACTIVE (el gate de contenido de trial se apaga solo al leer
    // el status). Cuenta también un ciclo a 0 € (cupón del 100%) — lo que NO
    // cuenta es la invoice inicial del alta (`subscription_create`), que en un
    // trial siempre es 0 € y no demuestra pago. Sin evento: el acceso ya
    // estaba concedido.
    if (
      sub.status === 'TRIALING' &&
      (invoice.amount_paid > 0 || invoice.billing_reason !== 'subscription_create')
    ) {
      await this.prisma.modSubscriptionsSubscription.update({
        where: { id: sub.id },
        data: { status: 'ACTIVE', trialEndsAt: null },
      });
    }

    await this.publisher.publish(sub.tenantId, sub.userId, EVENT.INVOICE_PAID, {
      subscriptionId: sub.id,
      stripeInvoiceId: invoice.id,
      amount: invoice.amount_paid,
      currency: invoice.currency,
    });
  }

  /**
   * Reembolso (total o parcial) de un cargo. Publicamos el evento de dominio
   * para que los consumidores reaccionen (p.ej. mod.referrals revoca la
   * comisión devengada por esa invoice). NO tocamos el estado de la sub ni de
   * la invoice local: el ciclo de vida de la suscripción lo gobiernan los
   * eventos de subscription/invoice de Stripe, no el refund.
   */
  private async onChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const stripeInvoiceId =
      typeof charge.invoice === 'string' ? charge.invoice : (charge.invoice?.id ?? null);
    if (!stripeInvoiceId) return;
    const invoice = await this.prisma.modSubscriptionsInvoice.findUnique({
      where: { stripeInvoiceId },
    });
    if (!invoice) return;

    await this.publisher.publish(invoice.tenantId, null, EVENT.INVOICE_REFUNDED, {
      subscriptionId: invoice.subscriptionId,
      stripeInvoiceId,
      amountRefunded: charge.amount_refunded,
      currency: charge.currency,
    });
  }

  private async onInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.subscription) return;
    const stripeSubId =
      typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id;
    const sub = await this.prisma.modSubscriptionsSubscription.findUnique({
      where: { stripeSubscriptionId: stripeSubId },
    });
    if (!sub) return;

    await this.upsertInvoice(sub.id, sub.tenantId, invoice, 'OPEN');

    // FIN DE TRIAL SIN PAGO: si el PRIMER cobro real (el que cierra la prueba)
    // falla, el acceso se pierde YA — sin grace period. La gracia existe para
    // clientes que ya pagaron alguna vez; un trial que nunca pagó no la tiene.
    // Si un reintento de Stripe cobra después, invoice.paid hace el recovery
    // (UNPAID → ACTIVE) y el bridge re-concede el acceso automáticamente.
    if (sub.status === 'TRIALING') {
      await this.prisma.modSubscriptionsSubscription.update({
        where: { id: sub.id },
        data: { status: 'UNPAID', trialEndsAt: null },
      });
      await this.publisher.publish(sub.tenantId, sub.userId, EVENT.UNPAID, {
        subscriptionId: sub.id,
        courseId: sub.courseId,
        planId: sub.planId,
        userId: sub.userId,
        trialExpired: true,
      });
      await this.publisher.publish(sub.tenantId, sub.userId, EVENT.INVOICE_FAILED, {
        subscriptionId: sub.id,
        stripeInvoiceId: invoice.id,
        attemptCount: invoice.attempt_count,
        nextPaymentAttempt: invoice.next_payment_attempt
          ? new Date(invoice.next_payment_attempt * 1000)
          : null,
      });
      return;
    }

    // Solo iniciamos grace si NO había uno ya — sino el alumno podría
    // re-iniciar grace tras cada reintento de Stripe.
    const graceEnd =
      sub.gracePeriodEndsAt ?? new Date(Date.now() + this.gracePeriodDays * 24 * 60 * 60 * 1000);
    await this.prisma.modSubscriptionsSubscription.update({
      where: { id: sub.id },
      data: {
        status: 'PAST_DUE',
        gracePeriodEndsAt: graceEnd,
      },
    });

    await this.publisher.publish(sub.tenantId, sub.userId, EVENT.PAST_DUE, {
      subscriptionId: sub.id,
      courseId: sub.courseId,
      planId: sub.planId,
      userId: sub.userId,
      gracePeriodEndsAt: graceEnd,
    });
    await this.publisher.publish(sub.tenantId, sub.userId, EVENT.INVOICE_FAILED, {
      subscriptionId: sub.id,
      stripeInvoiceId: invoice.id,
      attemptCount: invoice.attempt_count,
      nextPaymentAttempt: invoice.next_payment_attempt
        ? new Date(invoice.next_payment_attempt * 1000)
        : null,
    });
  }

  private async upsertInvoice(
    subscriptionLocalId: string,
    tenantId: string,
    invoice: Stripe.Invoice,
    status: 'OPEN' | 'PAID' | 'UNCOLLECTIBLE' | 'VOID',
  ): Promise<void> {
    if (!invoice.id) return;
    const existing = await this.prisma.modSubscriptionsInvoice.findUnique({
      where: { stripeInvoiceId: invoice.id },
    });
    const data = {
      tenantId,
      subscriptionId: subscriptionLocalId,
      stripeInvoiceId: invoice.id,
      status,
      amount: status === 'PAID' ? invoice.amount_paid : invoice.amount_due,
      currency: invoice.currency,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      paidAt: status === 'PAID' ? new Date() : null,
      periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : new Date(),
      periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : new Date(),
    };
    if (existing) {
      await this.prisma.modSubscriptionsInvoice.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await this.prisma.modSubscriptionsInvoice.create({ data });
    }
  }

  private extractLocalId(stripeSub: Stripe.Subscription): string | null {
    const meta = stripeSub.metadata ?? {};
    const value = meta['subscriptionLocalId'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}

/**
 * Mapeo de Stripe subscription.status (string union) → SubscriptionStatus local.
 *
 * - `trialing` la consideramos ACTIVE: para el alumno es lo mismo (acceso
 *   pleno) y el bridge no necesita distinguir.
 * - `incomplete` y `incomplete_expired`: Stripe los emite para subs que nunca
 *   confirmaron primer pago. Los tratamos como PENDING y CANCELED respectivamente.
 * - `paused` no debería llegar (no usamos pause API), pero por si acaso → PAST_DUE.
 */
function mapStripeStatus(
  s: string,
): 'PENDING' | 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'UNPAID' | 'CANCELED' {
  switch (s) {
    case 'active':
      return 'ACTIVE';
    case 'trialing':
      // Estado propio: el gate de contenido de la membresía (trialLessonLimit)
      // y la UI de cuenta distinguen "en prueba" de "activa".
      return 'TRIALING';
    case 'past_due':
      return 'PAST_DUE';
    case 'unpaid':
      return 'UNPAID';
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELED';
    case 'incomplete':
      return 'PENDING';
    case 'paused':
      return 'PAST_DUE';
    default:
      return 'PENDING';
  }
}
