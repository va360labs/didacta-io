/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsDbPort } from './accounts.service.js';
import { PayoutsAccountNotFoundError } from './errors.js';
import { idOf } from './event-router.js';
import { RefsService } from './refs.service.js';
import type { PlatformStripeClient } from './stripe/platform-stripe.client.js';

/**
 * Portal de cliente de Stripe del CREADOR en la cuenta del operador (etapa E5).
 *
 * Todas las academias cobran en la misma cuenta de Stripe, así que la
 * configuración por defecto del portal sería la del operador para todas. Cada
 * cuenta conectada tiene la SUYA (`bpc_…`, guardada en
 * `mod_payouts_account.portal_configuration_id`): el titular con el nombre de la
 * academia y solo lo que el alumno puede hacer él mismo —cambiar la tarjeta y
 * ver sus facturas—. La sesión se abre con `on_behalf_of` de la cuenta del
 * creador, así que lleva su nombre y su marca.
 *
 * Darse de baja NO está en el portal (versión 2 de la configuración): la baja
 * pasa por «Darme de baja» del aula, que pregunta el motivo y ofrece la pausa
 * o el descuento que haya configurado la creadora. Con la baja en el portal,
 * esa oferta se podía saltar. Las configuraciones creadas antes (versión 1) se
 * actualizan en Stripe la próxima vez que alguien abre el portal.
 *
 * Se crea perezosamente la primera vez que un alumno abre el portal. Dos
 * aperturas simultáneas no crean dos: la creación lleva clave de idempotencia
 * por cuenta y el guardado es condicionado.
 */

/** Versión vigente de la configuración del portal (2 = sin «cancelar»). */
export const PORTAL_CONFIGURATION_VERSION = 2;

/** Funciones del portal: tarjeta y facturas; la baja va por la oferta del aula. */
const PORTAL_FEATURES = {
  payment_method_update: { enabled: true },
  invoice_history: { enabled: true },
  subscription_cancel: { enabled: false },
} as const;

export interface PortalForAccount {
  /** `bpc_…` de la academia. */
  readonly configurationId: string;
  /** Cuenta conectada del creador: va como `on_behalf_of` de la sesión. */
  readonly onBehalfOf: string;
}

interface PortalConfigurationFromApi {
  readonly id: string;
  readonly livemode?: boolean;
}

export class PayoutsPortalService {
  constructor(
    private readonly db: PayoutsDbPort,
    private readonly stripe: PlatformStripeClient,
  ) {}

  /**
   * Configuración del portal de la academia, creándola si no existe.
   *
   * @param opts.headline Titular del portal (el nombre de la academia).
   * @throws PayoutsAccountNotFoundError si la academia no tiene cuenta conectada.
   */
  async ensureConfiguration(
    tenantId: string,
    opts: { readonly headline: string },
  ): Promise<PortalForAccount> {
    const account = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsAccount.findFirst({
        where: { tenantId, stripeAccountId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          stripeAccountId: true,
          portalConfigurationId: true,
          portalConfigVersion: true,
        },
      }),
    );
    if (!account?.stripeAccountId) throw new PayoutsAccountNotFoundError();
    if (account.portalConfigurationId) {
      if (account.portalConfigVersion < PORTAL_CONFIGURATION_VERSION) {
        await this.upgrade(tenantId, account.id, account.portalConfigurationId);
      }
      return {
        configurationId: account.portalConfigurationId,
        onBehalfOf: account.stripeAccountId,
      };
    }

    const headline = opts.headline.trim().slice(0, 60) || 'Gestiona tu suscripción';
    const created = await this.stripe.v1<PortalConfigurationFromApi>(
      'POST',
      '/v1/billing_portal/configurations',
      {
        business_profile: { headline },
        features: PORTAL_FEATURES,
        metadata: { didacta_tenant_id: tenantId, didacta_account_id: account.id },
      },
      { idempotencyKey: `payouts:portal-config:${account.id}` },
    );
    const configurationId = idOf(created.id);
    if (!configurationId) throw new Error('Stripe devolvió una configuración de portal sin id');

    return this.db.inTenant(tenantId, async (tx) => {
      await new RefsService(tx as never).register({
        tenantId,
        stripeObjectId: configurationId,
        kind: 'portal_configuration',
        source: 'payouts',
        localRef: account.id,
        parentObjectId: account.stripeAccountId,
        livemode: created.livemode === true,
      });
      await tx.modPayoutsAccount.updateMany({
        where: { id: account.id, tenantId, portalConfigurationId: null },
        data: {
          portalConfigurationId: configurationId,
          portalConfigVersion: PORTAL_CONFIGURATION_VERSION,
        },
      });
      const stored = await tx.modPayoutsAccount.findFirst({
        where: { id: account.id, tenantId },
        select: { portalConfigurationId: true },
      });
      return {
        configurationId: stored?.portalConfigurationId ?? configurationId,
        onBehalfOf: account.stripeAccountId!,
      };
    });
  }

  /**
   * Pone una configuración antigua al día en Stripe (quita «cancelar») y apunta
   * la versión. Idempotente: dos aperturas a la vez mandan la misma petición
   * con la misma clave. Si Stripe falla, el portal se abre igual con la
   * configuración que hay y se reintenta en la siguiente apertura.
   */
  private async upgrade(
    tenantId: string,
    accountId: string,
    configurationId: string,
  ): Promise<void> {
    try {
      await this.stripe.v1<PortalConfigurationFromApi>(
        'POST',
        `/v1/billing_portal/configurations/${encodeURIComponent(configurationId)}`,
        { features: PORTAL_FEATURES },
        { idempotencyKey: `payouts:portal-config:${accountId}:v${PORTAL_CONFIGURATION_VERSION}` },
      );
    } catch {
      return;
    }
    await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsAccount.updateMany({
        where: {
          id: accountId,
          tenantId,
          portalConfigVersion: { lt: PORTAL_CONFIGURATION_VERSION },
        },
        data: { portalConfigVersion: PORTAL_CONFIGURATION_VERSION },
      }),
    );
  }
}
