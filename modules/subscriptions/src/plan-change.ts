/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cambio de plan de una membresía viva (subir o bajar de nivel), la parte LOCAL.
 *
 * Hay dos caminos que llegan aquí y tienen que dejar lo mismo:
 *   1. El alumno cambia desde su cuenta (`MembershipService.changePlan`): Stripe
 *      confirma el cambio y se refleja en la fila.
 *   2. El webhook `customer.subscription.updated` trae en la metadata un
 *      `planId` distinto del de la fila (el paso 1 se cortó después de Stripe,
 *      o llegaron dos cambios a la vez).
 *
 * Por eso la escritura es un compare-and-swap sobre el plan de antes
 * (`updateMany` con `planId` en el `where`): el primero que llega aplica el
 * cambio y avisa (`subscriptions.membership.plan_changed`); el segundo ve 0
 * filas y no hace nada. Un único aviso por cambio, venga por donde venga.
 *
 * Quién da y quita el acceso: el host, escuchando el aviso (concede el grupo
 * del nivel nuevo y después retira el del viejo, solo lo que concedió la
 * membresía). Este módulo no escribe tablas de otros.
 */

import type { PrismaClient } from '@didacta/database';
import type { SubscriptionsEventPublisher } from './subscriptions.service.js';

/** El alumno cambió de plan (y quizá de nivel). Lo consume el puente de grupos. */
export const MEMBERSHIP_PLAN_CHANGED_EVENT = 'subscriptions.membership.plan_changed';

/**
 * Etiqueta informativa para la columna `interval` (texto libre): los periodos
 * con nombre usan el término clásico y el resto queda como «Nm» (p. ej. '6m').
 */
export function intervalLabel(intervalMonths: number): string {
  if (intervalMonths === 12) return 'year';
  if (intervalMonths === 3) return 'quarter';
  if (intervalMonths === 1) return 'month';
  return `${intervalMonths}m`;
}

/** Precio mensual equivalente (para decidir si un cambio sube o baja). */
export function monthlyEquivalent(plan: { amountCents: number; intervalMonths: number }): number {
  return plan.amountCents / Math.max(1, plan.intervalMonths);
}

export type PlanChangeDirection = 'upgrade' | 'downgrade';

/** Sube si el plan nuevo cuesta más al mes; si cuesta lo mismo o menos, baja. */
export function planChangeDirection(
  from: { amountCents: number; intervalMonths: number },
  to: { amountCents: number; intervalMonths: number },
): PlanChangeDirection {
  return monthlyEquivalent(to) > monthlyEquivalent(from) ? 'upgrade' : 'downgrade';
}

export interface ApplyPlanChangeArgs {
  tenantId: string;
  subscriptionId: string;
  userId: string;
  /** El plan que la fila tiene que tener para que el cambio se aplique. */
  fromPlanId: string | null;
  toPlan: {
    id: string;
    tierId: string | null;
    amountCents: number;
    currency: string;
    intervalMonths: number;
  };
  stripePriceId: string;
  currentPeriodEnd?: Date | null;
  /** Por dónde llegó: la cuenta del alumno o el webhook de Stripe. */
  via: 'account' | 'webhook';
  direction?: PlanChangeDirection | null;
}

/**
 * Refleja en la fila un cambio de plan que Stripe YA aplicó y avisa. Devuelve
 * `true` si lo aplicó esta llamada; `false` si la fila ya no tenía el plan de
 * antes (lo aplicó otro camino): entonces no avisa.
 */
export async function applyMembershipPlanChange(
  prisma: PrismaClient,
  publisher: SubscriptionsEventPublisher,
  args: ApplyPlanChangeArgs,
): Promise<boolean> {
  const { count } = await prisma.modSubscriptionsSubscription.updateMany({
    where: { id: args.subscriptionId, tenantId: args.tenantId, planId: args.fromPlanId },
    data: {
      planId: args.toPlan.id,
      stripePriceId: args.stripePriceId,
      unitAmount: args.toPlan.amountCents,
      currency: args.toPlan.currency,
      interval: intervalLabel(args.toPlan.intervalMonths),
      ...(args.currentPeriodEnd ? { currentPeriodEnd: args.currentPeriodEnd } : {}),
    },
  });
  if (count === 0) return false;

  const fromPlan = args.fromPlanId
    ? await prisma.modSubscriptionsPlan.findFirst({
        where: { id: args.fromPlanId, tenantId: args.tenantId },
        select: { tierId: true },
      })
    : null;
  await publisher.publish(args.tenantId, args.userId, MEMBERSHIP_PLAN_CHANGED_EVENT, {
    subscriptionId: args.subscriptionId,
    userId: args.userId,
    fromPlanId: args.fromPlanId,
    toPlanId: args.toPlan.id,
    fromTierId: fromPlan?.tierId ?? null,
    toTierId: args.toPlan.tierId,
    direction: args.direction ?? null,
    via: args.via,
  });
  return true;
}
