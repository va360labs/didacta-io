/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import type { BillingService } from '@didacta/mod-billing';
import type { MembershipService } from '@didacta/mod-subscriptions';
import {
  PLATFORM_PRICE_CURRENCIES,
  PayoutsNotReadyError,
  assertPlatformPrice,
  settlementCurrencyOf,
  type PriceCurrencyCheck,
} from '@didacta/mod-payouts';
import { runAsTenant, runGlobalWithoutTenant } from '../../tenancy/tenant-context.storage';
import type { PaymentModeNotReadyReason } from '../payment-mode.resolver';
import { PayoutsRuntime } from './payouts-runtime.service';

/** Motivo público de que un curso no esté a la venta en modo plataforma. */
export const PAYOUTS_NOT_READY_OFFER_REASON = 'payouts_not_ready';

/**
 * Lo que la venta PÚBLICA (catálogo, ficha, `/join`) necesita saber del cobro
 * de un aula, resuelto con UNA sola consulta del modo.
 */
export interface PublicCheckoutInfo {
  /** Por qué no puede vender todavía; `null` si puede (o cobra con claves propias). */
  readonly blockedReason: PaymentModeNotReadyReason | null;
  /** ¿Cobra por la plataforma? Ahí no hay cupones en el pago (`promotionCodes: 'deny'`). */
  readonly platform: boolean;
  /** Moneda de liquidación del creador; `null` con claves propias o sin cuenta lista. */
  readonly settlementCurrency: string | null;
}

/**
 * ¿Verá el alumno este precio en su moneda al pagar? Solo en modo plataforma y
 * con el precio en la moneda de liquidación del creador: es cuando Stripe
 * (Adaptive Pricing) lo convierte en el Checkout sin que el creador haga nada.
 */
export function localCurrencyAtCheckout(info: PublicCheckoutInfo, currency: string): boolean {
  return (
    info.platform &&
    info.settlementCurrency !== null &&
    currency.toLowerCase() === info.settlementCurrency
  );
}

/** Marca cada precio (opción de curso o plan) con `localCurrencyAtCheckout`. */
export function withLocalCurrencyHint<T extends { readonly currency: string }>(
  items: readonly T[],
  info: PublicCheckoutInfo,
): Array<T & { localCurrencyAtCheckout: boolean }> {
  return items.map((item) => ({
    ...item,
    localCurrencyAtCheckout: localCurrencyAtCheckout(info, item.currency),
  }));
}

/**
 * Puerta de la VENTA en modo plataforma, para los controladores de compra de
 * `mod.billing` (público y de alumno) y, desde E5, de la membresía (`/join`).
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

  /**
   * E8 — ¿Con qué monedas puede poner precios este aula? `null` si no cobra por
   * la plataforma (claves propias): ahí nada cambia. En modo plataforma, la
   * moneda de liquidación del creador (la de sus precios por defecto; `null`
   * si aún no ha conectado) y la lista de monedas admitidas.
   */
  async pricePolicy(
    tenantId: string,
  ): Promise<{ settlementCurrency: string | null; currencies: readonly string[] } | null> {
    const mode = await runAsTenant(tenantId, () => this.runtime.mode.resolve(tenantId));
    if (mode.mode === 'own') return null;
    const account = await runAsTenant(tenantId, () => this.runtime.accounts.getAccount(tenantId));
    return {
      settlementCurrency: settlementCurrencyOf(account),
      currencies: PLATFORM_PRICE_CURRENCIES,
    };
  }

  /**
   * E8 — valida un precio antes de crearlo o cambiarlo. Con claves propias no
   * hace nada (las monedas de siempre); en modo plataforma lanza
   * `PayoutsPriceCurrencyError` (422) si la moneda no es de la lista, el
   * importe no se puede cobrar en ella (5,50 ISK) o un precio extra por
   * mercado está mal. Una moneda de la lista distinta de la del creador NO es
   * un error: la interfaz le avisa de la conversión.
   */
  async assertPrice(tenantId: string, check: PriceCurrencyCheck): Promise<void> {
    if ((await this.pricePolicy(tenantId)) === null) return;
    assertPlatformPrice(check);
  }

  /**
   * Para la venta pública: si puede vender, si cobra por la plataforma y en qué
   * moneda liquida el creador. Con claves propias, `{ null, false, null }`: la
   * página es la de siempre (cupones en el pago, sin conversión automática).
   */
  async publicCheckoutInfo(tenantId: string): Promise<PublicCheckoutInfo> {
    const mode = await runAsTenant(tenantId, () => this.runtime.mode.resolve(tenantId));
    if (mode.mode !== 'platform') {
      return { blockedReason: null, platform: false, settlementCurrency: null };
    }
    if (!mode.ready) {
      return { blockedReason: mode.reason, platform: true, settlementCurrency: null };
    }
    const account = await runAsTenant(tenantId, () => this.runtime.accounts.getAccount(tenantId));
    return {
      blockedReason: null,
      platform: true,
      settlementCurrency: settlementCurrencyOf(account),
    };
  }

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
