/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import type { BillingService } from '@didacta/mod-billing';
import type { MembershipService } from '@didacta/mod-subscriptions';
import { PayoutsNotReadyError } from '@didacta/mod-payouts';
import { runAsTenant, runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import type { PaymentModeNotReadyReason } from '../payment-mode.resolver';
import { PayoutsRuntime } from './payouts-runtime.service';

/** Motivo público de que un curso no esté a la venta en modo plataforma. */
export const PAYOUTS_NOT_READY_OFFER_REASON = 'payouts_not_ready';

/**
 * Puerta de la VENTA en modo plataforma, para los controladores de compra de
 * `mod.billing` (público y de alumno) y, desde E5, de la membresía (`/unete`).
 *
 *  - Oferta: si el tenant cobra por la plataforma y su cuenta conectada aún no
 *    puede vender, el curso no está a la venta (`forSale: false` con motivo).
 *  - Checkout: en ese caso, 409 `PAYOUTS_NOT_READY` ANTES de crear la orden y
 *    la sesión. Si puede vender, deja el catálogo del curso en la cuenta del
 *    operador (`resyncStripeCatalog`): los precios creados cuando el tenant
 *    cobraba con sus claves no existen en ella.
 *
 * Solo existe con el modo plataforma encendido (`PayoutsModule`, global en ese
 * modo). Apagado, los controladores lo reciben `undefined` y son los de
 * siempre. Con el modo encendido y el tenant en `own` (claves propias), no
 * hace nada.
 */
@Injectable()
export class PlatformCheckoutGate {
  constructor(private readonly runtime: PayoutsRuntime) {}

  /** `null` si puede vender (o no cobra por la plataforma); si no, por qué. */
  async saleBlockedReason(tenantId: string): Promise<PaymentModeNotReadyReason | null> {
    const mode = await runAsTenant(tenantId, () => this.runtime.mode.resolve(tenantId));
    return mode.mode === 'platform' && !mode.ready ? mode.reason : null;
  }

  /**
   * Antes de `startCheckout`. Lanza `PayoutsNotReadyError` (409) si la cuenta
   * no puede vender; si puede, recrea en la cuenta del operador los precios del
   * curso que todavía no estén en ella.
   */
  async prepareCheckout(
    tenantId: string,
    courseId: string,
    billing: Pick<BillingService, 'resyncStripeCatalog'>,
  ): Promise<void> {
    const mode = await runAsTenant(tenantId, () => this.runtime.mode.resolve(tenantId));
    if (mode.mode !== 'platform') return;
    if (!mode.ready) throw new PayoutsNotReadyError(mode.reason);
    await runAsTenant(tenantId, () =>
      billing.resyncStripeCatalog(tenantId, {
        courseId,
        isCurrent: (stripePriceId) =>
          runGlobalWithoutTenant(() => this.runtime.refs.isPlatformObject([stripePriceId])),
      }),
    );
  }

  /**
   * E5 — antes de `startMembershipCheckout`. Lo mismo que `prepareCheckout`
   * para un plan de membresía: 409 si la cuenta no puede vender; si puede, el
   * precio del plan (y su Product) en la cuenta del operador.
   */
  async prepareMembershipCheckout(
    tenantId: string,
    planId: string,
    membership: Pick<MembershipService, 'resyncStripeCatalog'>,
  ): Promise<void> {
    const mode = await runAsTenant(tenantId, () => this.runtime.mode.resolve(tenantId));
    if (mode.mode !== 'platform') return;
    if (!mode.ready) throw new PayoutsNotReadyError(mode.reason);
    await runAsTenant(tenantId, () =>
      membership.resyncStripeCatalog(tenantId, {
        planId,
        isCurrent: (stripeId) =>
          runGlobalWithoutTenant(() => this.runtime.refs.isPlatformObject([stripeId])),
      }),
    );
  }

  /**
   * E5 — cuáles de estos clientes de Stripe son de la cuenta del operador (su
   * portal lleva la configuración del creador). Acceso sancionado al registro.
   */
  async platformObjects(stripeObjectIds: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const id of new Set(stripeObjectIds.filter((x) => x.length > 0))) {
      if (await runGlobalWithoutTenant(() => this.runtime.refs.isPlatformObject([id]))) {
        found.add(id);
      }
    }
    return found;
  }
}
