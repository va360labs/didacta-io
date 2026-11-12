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
 * academia y solo lo que el alumno puede hacer él mismo —cambiar la tarjeta,
 * ver sus facturas y darse de baja al final del periodo—. La sesión se abre con
 * `on_behalf_of` de la cuenta del creador, así que lleva su nombre y su marca.
 *
 * Se crea perezosamente la primera vez que un alumno abre el portal. Dos
 * aperturas simultáneas no crean dos: la creación lleva clave de idempotencia
 * por cuenta y el guardado es condicionado.
 */

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
        select: { id: true, stripeAccountId: true, portalConfigurationId: true },
      }),
    );
    if (!account?.stripeAccountId) throw new PayoutsAccountNotFoundError();
    if (account.portalConfigurationId) {
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
        features: {
          payment_method_update: { enabled: true },
          invoice_history: { enabled: true },
          subscription_cancel: { enabled: true, mode: 'at_period_end' },
        },
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
        data: { portalConfigurationId: configurationId },
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
}
