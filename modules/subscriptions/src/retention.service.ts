/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * RetentionService — la OFERTA AL DARSE DE BAJA.
 *
 * Cuando un alumno pulsa «Darme de baja»:
 *   1. se le pregunta el motivo (lista corta + texto libre);
 *   2. si la creadora lo ha configurado, se le ofrece PAUSAR la suscripción
 *      1–3 meses sin cobrar y/o un DESCUENTO de retención;
 *   3. si acepta, se aplica en Stripe y se confirma por correo; si no, se
 *      cancela como siempre (al final del periodo pagado) y se confirma.
 *
 * La regla de la pausa (decisión de producto, explicada al alumno):
 *   - empieza al acabar el periodo YA PAGADO (hasta entonces, todo igual);
 *   - durante la pausa no se cobra (Stripe anula cada factura nueva:
 *     `pause_collection.behavior = void`) y NO hay acceso al contenido; se
 *     conservan la cuenta, el progreso y los certificados;
 *   - salta cobros enteros: con un plan mensual, 1..máx meses; con uno
 *     trimestral, 3; con uno anual no se ofrece;
 *   - al acabar, Stripe vuelve a cobrar solo y el acceso vuelve cuando ese
 *     cobro entra. Una pausa por persona cada 12 meses.
 *
 * El descuento: un cupón de Stripe de UN SOLO USO creado para esta persona y
 * aplicado en el servidor (`X %` durante N meses en planes mensuales; en la
 * siguiente renovación en planes más largos). Una vez por persona y aula.
 *
 * Cobros de plataforma (mod.payouts): la suscripción vive en la cuenta del
 * operador y el adaptador enruta solo (lo decide el host). La pausa anula
 * facturas → no hay venta, ni comisión, ni transferencia. El descuento baja la
 * factura → la venta, el 5 % y la transferencia salen sobre lo que paga el
 * alumno. Nada de esto toca el libro: lo hace la liquidación de siempre.
 *
 * Este servicio no envía correos ni toca accesos: publica eventos y el host
 * (puentes) hace el resto.
 */

import { Prisma, type PrismaClient } from '@didacta/database';
import {
  RetentionAlreadyUsedError,
  RetentionConfigInvalidError,
  RetentionNotEligibleError,
  RetentionReasonInvalidError,
  SubscriptionAlreadyLeavingError,
  SubscriptionNotFoundError,
} from './errors.js';
import {
  DEFAULT_RETENTION_CONFIG,
  EXIT_REASONS,
  EXIT_REASON_TEXT_MAX,
  PAUSE_COOLDOWN_DAYS,
  discountPlan,
  discountedAmount,
  invalidRetentionField,
  isExitReason,
  pauseMonthOptions,
  pauseWindow,
  retentionCouponName,
  type DiscountPlan,
  type ExitReason,
  type RetentionConfigView,
} from './retention.js';
import type { StripeSubscriptionDetails } from './stripe-subscriptions.client.js';
import type {
  SubscriptionsEventPublisher,
  SubscriptionsStripeAdapterResolver,
} from './subscriptions.service.js';

type SubscriptionRow = Awaited<ReturnType<PrismaClient['modSubscriptionsSubscription']['create']>>;
type ExitRow = Awaited<ReturnType<PrismaClient['modSubscriptionsExit']['create']>>;

export const RETENTION_EVENT = {
  /** El alumno aceptó pausar (correo de confirmación). */
  PAUSE_ACCEPTED: 'subscriptions.retention.paused',
  /** El alumno aceptó el descuento (correo de confirmación). */
  DISCOUNT_ACCEPTED: 'subscriptions.retention.discounted',
  /** El alumno confirmó la baja al final del periodo (correo de confirmación). */
  CANCEL_CONFIRMED: 'subscriptions.retention.canceled',
  /** La pausa EMPIEZA: se retira el acceso (puentes de grupos y matrícula). */
  PAUSE_STARTED: 'subscriptions.subscription.paused',
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PauseOffer {
  /** Meses que se pueden elegir (p. ej. [1, 2, 3]). */
  months: number[];
  /** Fin del periodo pagado: aquí empieza la pausa. */
  startsAt: Date;
  /** Primer cobro (y vuelta del acceso) según los meses elegidos. */
  endsAtByMonths: Record<number, Date>;
}

export interface DiscountOffer {
  percent: number;
  /** Meses con descuento (`repeating`) o null (`once`: la siguiente renovación). */
  months: number | null;
  duration: DiscountPlan['duration'];
  /** Cuota sin y con descuento, en la unidad mínima de su moneda. */
  amountCents: number;
  discountedAmountCents: number;
  currency: string;
  /** Próxima renovación (la primera con descuento). */
  nextChargeAt: Date | null;
}

export interface LeaveOffer {
  subscriptionId: string;
  /** false si ya está cancelada o con la baja programada. */
  canLeave: boolean;
  reasons: readonly ExitReason[];
  /** Hasta cuándo conserva el acceso si se da de baja (fin del periodo pagado). */
  accessEndsAt: Date | null;
  pause: PauseOffer | null;
  discount: DiscountOffer | null;
}

export type LeaveChoice = 'pause' | 'discount' | 'cancel';

export interface LeaveInput {
  reason: string;
  reasonText?: string | null;
  choice: LeaveChoice;
  /** Solo con `choice: 'pause'`. */
  pauseMonths?: number;
}

export interface LeaveResult {
  outcome: 'PAUSED' | 'DISCOUNTED' | 'CANCELED';
  subscription: SubscriptionRow;
  exit: ExitRow;
}

export interface RetentionDiscountView {
  percent: number;
  months: number | null;
  duration: string;
  endsAt: Date | null;
}

export interface RetentionSummary {
  sinceDays: number;
  /** Personas que pulsaron «Darme de baja» y eligieron algo. */
  total: number;
  /** Se quedaron (pausa + descuento). */
  stayed: number;
  paused: number;
  discounted: number;
  canceled: number;
  /** Motivos de todas las salidas del periodo, de más a menos. */
  reasons: Array<{ reason: string; count: number }>;
  /** Suscripciones en pausa ahora mismo y pausas que aún no han empezado. */
  pausedNow: number;
  pausesScheduled: number;
  recent: Array<{
    id: string;
    createdAt: Date;
    outcome: 'PAUSED' | 'DISCOUNTED' | 'CANCELED';
    reason: string;
    reasonText: string | null;
    userId: string;
    userName: string | null;
    userEmail: string | null;
    pauseMonths: number | null;
    pauseEndsAt: Date | null;
    discountPercent: number | null;
    discountMonths: number | null;
    discountDuration: string | null;
  }>;
}

/** Cancela al final del periodo (la de siempre, de SubscriptionsService). */
export type CancelAtPeriodEnd = (
  tenantId: string,
  userId: string,
  subscriptionId: string,
) => Promise<SubscriptionRow>;

interface OfferComputation {
  offer: LeaveOffer;
  details: StripeSubscriptionDetails | null;
  pauseUsed: boolean;
  discountUsed: boolean;
}

export class RetentionService {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly stripeFor: SubscriptionsStripeAdapterResolver,
    private readonly publisher: SubscriptionsEventPublisher,
    private readonly cancelAtPeriodEnd: CancelAtPeriodEnd,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  // ---------------- Configuración (creadora) ----------------

  async getConfig(tenantId: string): Promise<RetentionConfigView> {
    const row = await this.prisma.modSubscriptionsRetentionConfig.findUnique({
      where: { tenantId },
    });
    if (!row) return { ...DEFAULT_RETENTION_CONFIG };
    return {
      pauseEnabled: row.pauseEnabled,
      pauseMaxMonths: row.pauseMaxMonths,
      discountEnabled: row.discountEnabled,
      discountPercent: row.discountPercent,
      discountMonths: row.discountMonths,
    };
  }

  async updateConfig(
    tenantId: string,
    input: Partial<RetentionConfigView>,
  ): Promise<RetentionConfigView> {
    const bad = invalidRetentionField(input);
    if (bad) throw new RetentionConfigInvalidError(bad);
    const data = {
      ...(input.pauseEnabled !== undefined ? { pauseEnabled: input.pauseEnabled } : {}),
      ...(input.pauseMaxMonths !== undefined ? { pauseMaxMonths: input.pauseMaxMonths } : {}),
      ...(input.discountEnabled !== undefined ? { discountEnabled: input.discountEnabled } : {}),
      ...(input.discountPercent !== undefined ? { discountPercent: input.discountPercent } : {}),
      ...(input.discountMonths !== undefined ? { discountMonths: input.discountMonths } : {}),
    };
    await this.prisma.modSubscriptionsRetentionConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });
    return this.getConfig(tenantId);
  }

  // ---------------- La oferta (alumno) ----------------

  /** Qué se le ofrece a este alumno para esta suscripción, ahora. */
  async getOffer(tenantId: string, userId: string, subscriptionId: string): Promise<LeaveOffer> {
    const sub = await this.ownSubscription(tenantId, userId, subscriptionId);
    return (await this.computeOffer(sub)).offer;
  }

  /**
   * Lo que el alumno decide: pausar, quedarse con el descuento o darse de baja.
   * El motivo es obligatorio en los tres casos y se guarda con lo elegido.
   */
  async leave(
    tenantId: string,
    userId: string,
    subscriptionId: string,
    input: LeaveInput,
  ): Promise<LeaveResult> {
    if (!isExitReason(input.reason)) throw new RetentionReasonInvalidError(String(input.reason));
    const reasonText = normalizeReasonText(input.reasonText);
    const sub = await this.ownSubscription(tenantId, userId, subscriptionId);
    if (!canLeave(sub)) throw new SubscriptionAlreadyLeavingError(sub.id);
    const computed = await this.computeOffer(sub);
    const base = { reason: input.reason, reasonText };
    switch (input.choice) {
      case 'pause':
        return this.acceptPause(sub, computed, base, input.pauseMonths);
      case 'discount':
        return this.acceptDiscount(sub, computed, base);
      case 'cancel':
        return this.confirmCancel(sub, computed, base);
      default:
        throw new RetentionNotEligibleError(`opción ${String(input.choice)}`);
    }
  }

  /** Descuentos de retención vivos de unas suscripciones (para «Mi suscripción»). */
  async activeDiscounts(
    tenantId: string,
    subscriptionIds: string[],
  ): Promise<Map<string, RetentionDiscountView>> {
    const out = new Map<string, RetentionDiscountView>();
    if (subscriptionIds.length === 0) return out;
    const now = this.now();
    const rows = await this.prisma.modSubscriptionsExit.findMany({
      where: {
        tenantId,
        subscriptionId: { in: subscriptionIds },
        outcome: 'DISCOUNTED',
        appliedAt: { not: null },
        OR: [{ discountEndsAt: null }, { discountEndsAt: { gt: now } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    for (const r of rows) {
      if (out.has(r.subscriptionId)) continue;
      out.set(r.subscriptionId, {
        percent: r.discountPercent ?? 0,
        months: r.discountMonths,
        duration: r.discountDuration ?? 'repeating',
        endsAt: r.discountEndsAt,
      });
    }
    return out;
  }

  // ---------------- Barrido: pausas que empiezan ----------------

  /** Mitad «sweep»: tenants con alguna pausa que ya debería haber empezado. */
  async findTenantsWithDuePauses(now: Date = this.now()): Promise<string[]> {
    const rows = await this.prisma.modSubscriptionsSubscription.findMany({
      where: {
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
        pauseStartsAt: { lte: now },
        pauseEndsAt: { gt: now },
      },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    return [...new Set(rows.map((r) => r.tenantId))];
  }

  /**
   * Mitad «procesado» (por tenant): las suscripciones cuya pausa ya empezó
   * pasan a PAUSED y se publica `subscriptions.subscription.paused` (los
   * puentes retiran el acceso). Es la red de seguridad del webhook de la
   * renovación, que normalmente lo hace antes (`onSubscriptionUpdated`).
   */
  async startDuePausesForTenant(
    tenantId: string,
    now: Date = this.now(),
  ): Promise<SubscriptionRow[]> {
    const due = await this.prisma.modSubscriptionsSubscription.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
        pauseStartsAt: { lte: now },
        pauseEndsAt: { gt: now },
      },
    });
    const started: SubscriptionRow[] = [];
    for (const sub of due) {
      // Compare-and-swap: si un webhook la movió entre medias, no se toca.
      const { count } = await this.prisma.modSubscriptionsSubscription.updateMany({
        where: { id: sub.id, tenantId, status: 'ACTIVE', pauseStartsAt: sub.pauseStartsAt },
        data: { status: 'PAUSED' },
      });
      if (count === 0) continue;
      started.push(sub);
      await this.publisher.publish(tenantId, null, RETENTION_EVENT.PAUSE_STARTED, {
        subscriptionId: sub.id,
        courseId: sub.courseId,
        planId: sub.planId,
        userId: sub.userId,
        pauseEndsAt: sub.pauseEndsAt,
      });
    }
    return started;
  }

  // ---------------- Resumen (creadora) ----------------

  async summary(tenantId: string, opts: { sinceDays?: number } = {}): Promise<RetentionSummary> {
    const sinceDays = clampInt(opts.sinceDays ?? 90, 1, 3650);
    const now = this.now();
    const since = new Date(now.getTime() - sinceDays * DAY_MS);
    const [exits, pausedNow, pausesScheduled] = await Promise.all([
      this.prisma.modSubscriptionsExit.findMany({
        where: {
          tenantId,
          createdAt: { gte: since },
          // Un descuento que no llegó a aplicarse no cuenta.
          OR: [{ outcome: { not: 'DISCOUNTED' } }, { appliedAt: { not: null } }],
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
      this.prisma.modSubscriptionsSubscription.count({ where: { tenantId, status: 'PAUSED' } }),
      this.prisma.modSubscriptionsSubscription.count({
        where: { tenantId, status: 'ACTIVE', pauseStartsAt: { gt: now } },
      }),
    ]);
    const byReason = new Map<string, number>();
    let paused = 0;
    let discounted = 0;
    let canceled = 0;
    for (const e of exits) {
      byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
      if (e.outcome === 'PAUSED') paused += 1;
      else if (e.outcome === 'DISCOUNTED') discounted += 1;
      else canceled += 1;
    }
    const reasons = [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || reasonOrder(a.reason) - reasonOrder(b.reason));

    const recentRows = exits.slice(0, 20);
    const userIds = [...new Set(recentRows.map((e) => e.userId))];
    // Lectura del `user` del core filtrada por tenant (solo nombre y correo).
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { tenantId, id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    return {
      sinceDays,
      total: exits.length,
      stayed: paused + discounted,
      paused,
      discounted,
      canceled,
      reasons,
      pausedNow,
      pausesScheduled,
      recent: recentRows.map((e) => ({
        id: e.id,
        createdAt: e.createdAt,
        outcome: e.outcome,
        reason: e.reason,
        reasonText: e.reasonText,
        userId: e.userId,
        userName: userById.get(e.userId)?.name ?? null,
        userEmail: userById.get(e.userId)?.email ?? null,
        pauseMonths: e.pauseMonths,
        pauseEndsAt: e.pauseEndsAt,
        discountPercent: e.discountPercent,
        discountMonths: e.discountMonths,
        discountDuration: e.discountDuration,
      })),
    };
  }

  // ---------------- Internos ----------------

  /** La suscripción, si es de este alumno. Ajena o inexistente: 404 sin decir cuál. */
  private async ownSubscription(
    tenantId: string,
    userId: string,
    subscriptionId: string,
  ): Promise<SubscriptionRow> {
    const sub = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: { id: subscriptionId, tenantId },
    });
    if (!sub || sub.userId !== userId) throw new SubscriptionNotFoundError(subscriptionId);
    return sub;
  }

  private async computeOffer(sub: SubscriptionRow): Promise<OfferComputation> {
    const leaving = canLeave(sub);
    const offer: LeaveOffer = {
      subscriptionId: sub.id,
      canLeave: leaving,
      reasons: EXIT_REASONS,
      // En pausa ya no hay acceso: darse de baja solo evita el cobro de la vuelta.
      accessEndsAt:
        sub.status === 'PAUSED'
          ? null
          : sub.status === 'TRIALING'
            ? (sub.trialEndsAt ?? sub.currentPeriodEnd)
            : (sub.currentPeriodEnd ?? null),
      pause: null,
      discount: null,
    };
    const result: OfferComputation = {
      offer,
      details: null,
      pauseUsed: false,
      discountUsed: false,
    };
    if (!leaving || !sub.stripeSubscriptionId) return result;

    const config = await this.getConfig(sub.tenantId);
    const wantsPause = config.pauseEnabled && sub.status === 'ACTIVE' && !sub.pauseStartsAt;
    const wantsDiscount =
      config.discountEnabled && (sub.status === 'ACTIVE' || sub.status === 'TRIALING');
    if (!wantsPause && !wantsDiscount) return result;

    const now = this.now();
    const [pauseUsed, discountUsed] = await Promise.all([
      wantsPause
        ? this.prisma.modSubscriptionsExit
            .findFirst({
              where: {
                tenantId: sub.tenantId,
                userId: sub.userId,
                outcome: 'PAUSED',
                createdAt: { gte: new Date(now.getTime() - PAUSE_COOLDOWN_DAYS * DAY_MS) },
              },
              select: { id: true },
            })
            .then(Boolean)
        : Promise.resolve(false),
      wantsDiscount
        ? this.prisma.modSubscriptionsExit
            .findFirst({
              where: { tenantId: sub.tenantId, discountedUserId: sub.userId },
              select: { id: true },
            })
            .then(Boolean)
        : Promise.resolve(false),
    ]);
    result.pauseUsed = pauseUsed;
    result.discountUsed = discountUsed;
    if (!(wantsPause && !pauseUsed) && !(wantsDiscount && !discountUsed)) return result;

    // El estado real lo tiene Stripe. Si no contesta, no se ofrece nada: la
    // baja tiene que poder hacerse igual.
    let details: StripeSubscriptionDetails;
    try {
      details = await (
        await this.stripeFor(sub.tenantId)
      ).retrieveSubscription(sub.stripeSubscriptionId);
    } catch {
      return result;
    }
    result.details = details;
    if (details.cancelAtPeriodEnd) return result;
    const periodEnd = details.currentPeriodEnd ? new Date(details.currentPeriodEnd * 1000) : null;
    if (periodEnd) {
      offer.accessEndsAt = periodEnd;
    }

    if (
      wantsPause &&
      !pauseUsed &&
      details.status === 'active' &&
      !details.pauseCollection &&
      periodEnd
    ) {
      const months = pauseMonthOptions(details.intervalMonths, config.pauseMaxMonths);
      if (months.length > 0) {
        offer.pause = {
          months,
          startsAt: periodEnd,
          endsAtByMonths: Object.fromEntries(
            months.map((m) => [m, pauseWindow(periodEnd, m).endsAt]),
          ),
        };
      }
    }

    if (
      wantsDiscount &&
      !discountUsed &&
      (details.status === 'active' || details.status === 'trialing') &&
      !details.hasDiscount
    ) {
      const plan = discountPlan(details.intervalMonths, config.discountMonths);
      offer.discount = {
        percent: config.discountPercent,
        months: plan.durationInMonths,
        duration: plan.duration,
        amountCents: sub.unitAmount,
        discountedAmountCents: discountedAmount(sub.unitAmount, config.discountPercent),
        currency: sub.currency,
        nextChargeAt: periodEnd,
      };
    }
    return result;
  }

  private async acceptPause(
    sub: SubscriptionRow,
    computed: OfferComputation,
    base: { reason: ExitReason; reasonText: string | null },
    pauseMonths: number | undefined,
  ): Promise<LeaveResult> {
    const pause = computed.offer.pause;
    if (!pause) {
      if (computed.pauseUsed) throw new RetentionAlreadyUsedError('pause');
      throw new RetentionNotEligibleError('pausa');
    }
    const months = pauseMonths ?? pause.months[0]!;
    if (!pause.months.includes(months)) throw new RetentionNotEligibleError(`${months} meses`);
    const window = pauseWindow(pause.startsAt, months);

    // Reserva: solo una pausa a la vez. Un doble clic se queda en 409.
    const { count } = await this.prisma.modSubscriptionsSubscription.updateMany({
      where: {
        id: sub.id,
        tenantId: sub.tenantId,
        status: 'ACTIVE',
        pauseStartsAt: null,
        cancelAtPeriodEnd: false,
      },
      data: {
        pauseStartsAt: window.startsAt,
        pauseEndsAt: window.endsAt,
        currentPeriodEnd: window.startsAt,
      },
    });
    if (count !== 1) throw new RetentionNotEligibleError('pausa en curso');

    try {
      const stripe = await this.stripeFor(sub.tenantId);
      await stripe.pauseCollection({
        subscriptionId: sub.stripeSubscriptionId!,
        resumesAt: Math.floor(window.resumesAt.getTime() / 1000),
        idempotencyKey: `retention-pause:${sub.id}:${window.startsAt.getTime()}`,
      });
    } catch (err) {
      await this.prisma.modSubscriptionsSubscription.updateMany({
        where: { id: sub.id, tenantId: sub.tenantId, pauseStartsAt: window.startsAt },
        data: { pauseStartsAt: null, pauseEndsAt: null },
      });
      throw err;
    }

    const exit = await this.prisma.modSubscriptionsExit.create({
      data: {
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
        userId: sub.userId,
        ...base,
        outcome: 'PAUSED',
        offeredPause: true,
        offeredDiscount: computed.offer.discount !== null,
        pauseMonths: months,
        pauseStartsAt: window.startsAt,
        pauseEndsAt: window.endsAt,
        appliedAt: this.now(),
      },
    });
    await this.publisher.publish(sub.tenantId, sub.userId, RETENTION_EVENT.PAUSE_ACCEPTED, {
      subscriptionId: sub.id,
      exitId: exit.id,
      userId: sub.userId,
      planId: sub.planId,
      courseId: sub.courseId,
      months,
      pauseStartsAt: window.startsAt.toISOString(),
      pauseEndsAt: window.endsAt.toISOString(),
    });
    return { outcome: 'PAUSED', subscription: await this.reload(sub), exit };
  }

  private async acceptDiscount(
    sub: SubscriptionRow,
    computed: OfferComputation,
    base: { reason: ExitReason; reasonText: string | null },
  ): Promise<LeaveResult> {
    const discount = computed.offer.discount;
    if (!discount) {
      if (computed.discountUsed) throw new RetentionAlreadyUsedError('discount');
      throw new RetentionNotEligibleError('descuento');
    }
    const plan: DiscountPlan =
      discount.duration === 'repeating'
        ? { duration: 'repeating', durationInMonths: discount.months ?? 1 }
        : { duration: 'once', durationInMonths: null };

    // Primero la fila (con el único por persona), después Stripe: dos clics a
    // la vez no crean dos cupones.
    let exit: ExitRow;
    try {
      exit = await this.prisma.modSubscriptionsExit.create({
        data: {
          tenantId: sub.tenantId,
          subscriptionId: sub.id,
          userId: sub.userId,
          ...base,
          outcome: 'DISCOUNTED',
          offeredPause: computed.offer.pause !== null,
          offeredDiscount: true,
          discountPercent: discount.percent,
          discountMonths: plan.durationInMonths,
          discountDuration: plan.duration,
          discountedUserId: sub.userId,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new RetentionAlreadyUsedError('discount');
      throw err;
    }

    let applied: { couponId: string; discountEnd: number | null };
    try {
      const stripe = await this.stripeFor(sub.tenantId);
      applied = await stripe.applyRetentionDiscount({
        subscriptionId: sub.stripeSubscriptionId!,
        percentOff: discount.percent,
        duration: plan.duration,
        ...(plan.duration === 'repeating' ? { durationInMonths: plan.durationInMonths } : {}),
        name: retentionCouponName(discount.percent, plan),
        metadata: {
          didacta: 'retention',
          tenantId: sub.tenantId,
          subscriptionId: sub.id,
          exitId: exit.id,
        },
        idempotencyKey: `retention-discount:${exit.id}`,
      });
    } catch (err) {
      // Sin descuento en Stripe no hay descuento: la fila se va y puede reintentar.
      await this.prisma.modSubscriptionsExit.deleteMany({
        where: { id: exit.id, tenantId: sub.tenantId, appliedAt: null },
      });
      throw err;
    }

    const endsAt = applied.discountEnd
      ? new Date(applied.discountEnd * 1000)
      : plan.duration === 'once'
        ? discount.nextChargeAt
        : null;
    exit = await this.prisma.modSubscriptionsExit.update({
      where: { id: exit.id },
      data: { stripeCouponId: applied.couponId, discountEndsAt: endsAt, appliedAt: this.now() },
    });
    await this.publisher.publish(sub.tenantId, sub.userId, RETENTION_EVENT.DISCOUNT_ACCEPTED, {
      subscriptionId: sub.id,
      exitId: exit.id,
      userId: sub.userId,
      planId: sub.planId,
      courseId: sub.courseId,
      percent: discount.percent,
      months: plan.durationInMonths,
      duration: plan.duration,
      amountCents: discount.amountCents,
      discountedAmountCents: discount.discountedAmountCents,
      currency: discount.currency,
      nextChargeAt: discount.nextChargeAt?.toISOString() ?? null,
      discountEndsAt: endsAt?.toISOString() ?? null,
    });
    return { outcome: 'DISCOUNTED', subscription: await this.reload(sub), exit };
  }

  private async confirmCancel(
    sub: SubscriptionRow,
    computed: OfferComputation,
    base: { reason: ExitReason; reasonText: string | null },
  ): Promise<LeaveResult> {
    const updated = await this.cancelAtPeriodEnd(sub.tenantId, sub.userId, sub.id);
    const exit = await this.prisma.modSubscriptionsExit.create({
      data: {
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
        userId: sub.userId,
        ...base,
        outcome: 'CANCELED',
        offeredPause: computed.offer.pause !== null,
        offeredDiscount: computed.offer.discount !== null,
        appliedAt: this.now(),
      },
    });
    const accessEndsAt =
      updated.status === 'CANCELED' || updated.status === 'PAUSED'
        ? null
        : (updated.currentPeriodEnd ?? computed.offer.accessEndsAt ?? null);
    await this.publisher.publish(sub.tenantId, sub.userId, RETENTION_EVENT.CANCEL_CONFIRMED, {
      subscriptionId: sub.id,
      exitId: exit.id,
      userId: sub.userId,
      planId: sub.planId,
      courseId: sub.courseId,
      accessEndsAt: accessEndsAt ? accessEndsAt.toISOString() : null,
    });
    return { outcome: 'CANCELED', subscription: updated, exit };
  }

  private async reload(sub: SubscriptionRow): Promise<SubscriptionRow> {
    return (
      (await this.prisma.modSubscriptionsSubscription.findFirst({
        where: { id: sub.id, tenantId: sub.tenantId },
      })) ?? sub
    );
  }
}

/** ¿Hay algo que dar de baja? (no cancelada ni con la baja ya programada). */
function canLeave(sub: Pick<SubscriptionRow, 'status' | 'cancelAtPeriodEnd'>): boolean {
  return sub.status !== 'CANCELED' && !sub.cancelAtPeriodEnd;
}

function normalizeReasonText(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  return text ? text.slice(0, EXIT_REASON_TEXT_MAX) : null;
}

function reasonOrder(reason: string): number {
  const i = (EXIT_REASONS as readonly string[]).indexOf(reason);
  return i === -1 ? EXIT_REASONS.length : i;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return true;
  if ((err as { code?: string } | null)?.code === 'P2002') return true;
  return ((err as Error | null)?.message ?? '').includes('Unique constraint');
}
