/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { stripeIdsNamedByEvent } from '@didacta/mod-payouts';
import { runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import { PayoutsRuntime } from './payouts-runtime.service';

/** Lo que hace falta de un evento de Stripe para saber qué nombra. */
export interface StripeEventLike {
  readonly id: string;
  readonly type: string;
  readonly account?: string | null;
  readonly data?: { readonly object?: unknown } | null;
}

/**
 * ¿Nombra este evento un cobro de la PLATAFORMA?
 *
 * Lo consultan los webhooks HEREDADOS (`/modules/billing/webhook` y
 * `/modules/subscriptions/webhook`, firmados con las claves propias de cada
 * aula) para rechazar con 403 cualquier evento sobre un objeto que registró el
 * modo plataforma: la sesión, su PaymentIntent, su cargo, su cliente… o la
 * orden local de una de esas sesiones (`metadata.orderId`), por si el evento
 * se inventa el `cs_…`.
 *
 * Solo existe con el modo plataforma encendido: `PayoutsModule` lo provee y es
 * global en ese modo. Apagado, los controladores lo reciben `undefined` y son
 * los de siempre.
 */
@Injectable()
export class PlatformObjectGuard {
  constructor(private readonly runtime: PayoutsRuntime) {}

  async namesPlatformObject(event: StripeEventLike): Promise<boolean> {
    const object = (event.data?.object ?? {}) as {
      metadata?: Record<string, unknown> | null;
      client_reference_id?: unknown;
    };
    const localRefs = [object.metadata?.['orderId'], object.client_reference_id].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return runGlobalWithoutTenant(() =>
      this.runtime.refs.isPlatformObject(stripeIdsNamedByEvent(event), {
        checkoutLocalRefs: localRefs,
      }),
    );
  }
}
