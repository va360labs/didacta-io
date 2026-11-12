/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FetchPlatformStripeClient, type PlatformStripeClient } from '@didacta/mod-payouts';
import { AdminTenantsPayoutsController } from '../../admin/admin-tenants.controller';
import { AuthModule } from '../../auth/auth.module';
import { PayoutsAccountsWorker } from './payouts-accounts.worker';
import { PayoutsReconcileWorker } from './payouts-reconcile.worker';
import { PayoutsSalesController } from './payouts-sales.controller';
import { PayoutsSettleWorker } from './payouts-settle.worker';
import { PayoutsController } from './payouts.controller';
import { PayoutsErrorFilter } from './payouts-error.filter';
import {
  PLATFORM_PAYMENTS_CONFIG,
  PLATFORM_STRIPE_CLIENT,
  PayoutsRuntime,
} from './payouts-runtime.service';
import { PlatformCheckoutGate } from './platform-checkout-gate';
import {
  ModulesPlatformEventDispatcher,
  PLATFORM_EVENT_DISPATCHER,
  type PlatformEventDispatcher,
} from './platform-event-dispatcher';
import { PlatformObjectGuard } from './platform-object-guard';
import { PlatformWebhookController } from './platform-webhook.controller';
import { getPlatformPaymentsConfig, type PlatformPaymentsConfig } from './platform-payments.config';

/**
 * Backend de `mod.payouts` (cobros de plataforma) en el host.
 *
 * `register()` decide al cargar el grafo de Nest:
 *
 *  - Modo plataforma APAGADO (sin `PAYMENTS_PLATFORM_STRIPE_SECRET_KEY`, toda
 *    Community): módulo vacío. Ni controladores, ni worker, ni filtro, ni
 *    cliente de Stripe. Las rutas `/modules/payouts/*` y las dos del pool no
 *    existen: la instalación tiene las mismas rutas que antes.
 *  - Modo plataforma ENCENDIDO: el webhook único, las rutas del creador
 *    («Tus ventas» incluidas), las tres del contrato del pool
 *    (`AdminTenantsPayoutsController`), el conciliador de cuentas, el barrido
 *    de liquidación y el conciliador de cobros. Y el módulo es GLOBAL: lo que exporta lo
 *    reciben con `@Optional()` piezas del host que no lo importan —
 *    `ModuleRegistryService` (adaptadores de Stripe por modo de cobro), los
 *    webhooks heredados (`PlatformObjectGuard`: 403 a eventos de plataforma)
 *    y los controladores de compra (`PlatformCheckoutGate`). Apagado no
 *    exporta nada y todos ellos reciben `undefined`: son los de siempre.
 *
 * El registro del manifiesto en el `ModuleRegistry` sigue la MISMA decisión
 * (`module-registry.service.ts`): apagado, `mod.payouts` no aparece en el
 * listado de módulos.
 */
@Module({})
export class PayoutsModule {
  /**
   * @param overrides.stripe Solo tests: el doble en memoria en vez del cliente
   *   real. En producción nadie lo pasa.
   * @param overrides.dispatcher Solo tests: el reparto a módulos, para montar
   *   el webhook sin el grafo entero de módulos.
   */
  static register(
    config: PlatformPaymentsConfig = getPlatformPaymentsConfig(),
    overrides: {
      readonly stripe?: PlatformStripeClient;
      readonly dispatcher?: PlatformEventDispatcher;
    } = {},
  ): DynamicModule {
    if (!config.enabled) return { module: PayoutsModule };
    return {
      module: PayoutsModule,
      global: true,
      imports: [AuthModule],
      controllers: [
        PayoutsController,
        PayoutsSalesController,
        PlatformWebhookController,
        AdminTenantsPayoutsController,
      ],
      providers: [
        { provide: PLATFORM_PAYMENTS_CONFIG, useValue: config },
        {
          provide: PLATFORM_STRIPE_CLIENT,
          useFactory: () =>
            overrides.stripe ?? new FetchPlatformStripeClient({ secretKey: config.secretKey }),
        },
        PayoutsRuntime,
        PayoutsAccountsWorker,
        PayoutsSettleWorker,
        PayoutsReconcileWorker,
        PlatformObjectGuard,
        PlatformCheckoutGate,
        overrides.dispatcher
          ? { provide: PLATFORM_EVENT_DISPATCHER, useValue: overrides.dispatcher }
          : { provide: PLATFORM_EVENT_DISPATCHER, useClass: ModulesPlatformEventDispatcher },
        { provide: APP_FILTER, useClass: PayoutsErrorFilter },
      ],
      exports: [PayoutsRuntime, PlatformObjectGuard, PlatformCheckoutGate],
    };
  }
}
