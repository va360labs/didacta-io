/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsDbPort } from '../accounts.service.js';
import { idOf } from '../event-router.js';
import { RefsService, type ObjectRef, type RegisterObjectRefInput } from '../refs.service.js';
import type { PlatformStripeClient } from '../stripe/platform-stripe.client.js';

/**
 * Suscripciones cobradas por la plataforma (etapa E5): registro de los hijos
 * de la sesión de checkout.
 *
 * El servidor solo registra a nombre del tenant la SESIÓN (`cs_…`), al crearla.
 * Todo lo que Stripe crea después en la cuenta del operador —la suscripción
 * (`sub_…`) y su cliente (`cus_…`)— hay que atarlo a esa sesión para que los
 * eventos que vengan sin ella (`customer.subscription.*`, `invoice.*`,
 * `charge.*` de cada renovación) se atribuyan sin preguntar a Stripe cada vez.
 *
 * Se llama cuando el evento ya está atribuido por la sesión: en
 * `checkout.session.completed`, o en el primer evento de la suscripción que se
 * atribuyó consultando a Stripe la sesión de origen (si llega antes que el
 * `completed`). Los ids se LEEN DE LA API (`GET /v1/checkout/sessions/{id}`),
 * no del evento.
 */

/** Orígenes de una sesión de suscripción (los registra el adaptador del host). */
export const SUBSCRIPTION_REF_SOURCES: ReadonlySet<string> = new Set([
  'membership',
  'subscriptions',
]);

export type SubscriptionChildrenOutcome =
  | {
      readonly outcome: 'registered';
      readonly subscriptionId: string;
      readonly customerId: string | null;
      /** Cuántos ids eran nuevos (0 en una reentrega). */
      readonly created: number;
    }
  /** La sesión no es de una suscripción, o Stripe aún no la ha creado. */
  | { readonly outcome: 'no_subscription' };

interface SessionFromApi {
  readonly id: string;
  readonly mode?: string;
  readonly livemode?: boolean;
  readonly subscription?: unknown;
  readonly customer?: unknown;
}

export async function registerSubscriptionChildren(
  deps: { readonly db: PayoutsDbPort; readonly stripe: PlatformStripeClient },
  input: {
    readonly tenantId: string;
    /** Registro de la sesión (`checkout_session`, origen membresía/suscripciones). */
    readonly sessionRef: ObjectRef;
  },
): Promise<SubscriptionChildrenOutcome> {
  const { sessionRef } = input;
  if (
    sessionRef.kind !== 'checkout_session' ||
    !SUBSCRIPTION_REF_SOURCES.has(sessionRef.source) ||
    sessionRef.tenantId !== input.tenantId
  ) {
    return { outcome: 'no_subscription' };
  }
  const session = await deps.stripe.v1<SessionFromApi>(
    'GET',
    `/v1/checkout/sessions/${encodeURIComponent(sessionRef.stripeObjectId)}`,
  );
  const subscriptionId = idOf(session.subscription);
  if (session.mode !== 'subscription' || !subscriptionId) return { outcome: 'no_subscription' };
  const customerId = idOf(session.customer);
  const livemode = session.livemode === true;
  const source = sessionRef.source as RegisterObjectRefInput['source'];

  const children: RegisterObjectRefInput[] = [
    {
      tenantId: input.tenantId,
      stripeObjectId: subscriptionId,
      kind: 'subscription',
      source,
      localRef: sessionRef.localRef,
      parentObjectId: sessionRef.stripeObjectId,
      livemode,
    },
    ...(customerId
      ? [
          {
            tenantId: input.tenantId,
            stripeObjectId: customerId,
            kind: 'customer' as const,
            source,
            localRef: sessionRef.localRef,
            parentObjectId: sessionRef.stripeObjectId,
            livemode,
          },
        ]
      : []),
  ];
  const { created } = await deps.db.inTenant(input.tenantId, (tx) =>
    new RefsService(tx as never).registerMany(children),
  );
  return { outcome: 'registered', subscriptionId, customerId, created };
}
