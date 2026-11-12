/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type Stripe from 'stripe';
import type { ClientContext } from '../../auth/client-context';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { BillingProvisioningService } from '../billing/billing-provisioning.service';
import { ModuleRegistryService } from '../module-registry.service';
import {
  collectStripeEventClaims,
  dispatchStripeEventToAll,
  type StripeDispatchLogger,
  type StripeEventConsumers,
} from '../stripe-event-dispatch';
import { MembershipProvisioningService } from '../subscriptions/membership-provisioning.service';

/**
 * Lo que el webhook de plataforma necesita de los módulos que consumen eventos
 * de Stripe: a qué tenants nombra el evento y repartirlo, igual que los
 * webhooks heredados (`stripe-event-dispatch.ts`).
 */
export interface PlatformEventDispatcher {
  /** Tenants que nombra (metadata) o toca (filas) según billing/suscripciones/membresía. */
  claims(event: Stripe.Event): Promise<string[]>;
  /** Reparte a los tres módulos bajo el tenant ya decidido. Un fallo sale (5xx). */
  dispatch(args: {
    event: Stripe.Event;
    parsedBody: unknown;
    tenantId: string;
    ctx: ClientContext;
    logger: StripeDispatchLogger;
  }): Promise<void>;
}

export const PLATFORM_EVENT_DISPATCHER = Symbol('PLATFORM_EVENT_DISPATCHER');

/**
 * Implementación real: los servicios de los módulos y los provisioners del
 * host se buscan en el contenedor de la aplicación al primer evento
 * (`ModuleRef`, sin `strict`).
 *
 * Por qué no se inyectan: `PayoutsModule` lo importa `ModulesModule`, y
 * `BillingModule`/`SubscriptionsModule` importan `ModulesModule`; importar
 * cualquiera de ellos desde aquí cierra un ciclo de módulos y arrastra el
 * grafo entero a cualquier prueba que monte solo `PayoutsModule`.
 */
@Injectable()
export class ModulesPlatformEventDispatcher implements PlatformEventDispatcher {
  constructor(private readonly moduleRef: ModuleRef) {}

  private consumers(): StripeEventConsumers {
    const registry = this.moduleRef.get(ModuleRegistryService, { strict: false });
    return {
      billing: registry.getBillingService(),
      subscriptions: registry.getSubscriptionsService(),
      membership: registry.getMembershipService(),
    };
  }

  claims(event: Stripe.Event): Promise<string[]> {
    return collectStripeEventClaims(event, this.consumers());
  }

  async dispatch(args: {
    event: Stripe.Event;
    parsedBody: unknown;
    tenantId: string;
    ctx: ClientContext;
    logger: StripeDispatchLogger;
  }): Promise<void> {
    const tenantResolver = this.moduleRef.get(TenantResolverService, { strict: false });
    const billingProvisioning = this.moduleRef.get(BillingProvisioningService, { strict: false });
    const membershipProvisioning = this.moduleRef.get(MembershipProvisioningService, {
      strict: false,
    });
    // La petición es de Stripe, no del navegador del aula: el dominio de los
    // enlaces de bienvenida es el primario del tenant, como en un envío de fondo.
    const webBaseUrl = await tenantResolver.resolveTenantWebBaseUrlForBackground(args.tenantId);
    await dispatchStripeEventToAll({
      event: args.event,
      parsedBody: args.parsedBody,
      tenantId: args.tenantId,
      webBaseUrl,
      ctx: args.ctx,
      consumers: this.consumers(),
      provisionMember: (input) => membershipProvisioning.provision(input),
      provisionBuyer: (input) => billingProvisioning.provision(input),
      logger: args.logger,
    });
  }
}
