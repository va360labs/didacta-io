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
import { PayoutsController } from './payouts.controller';
import { PayoutsErrorFilter } from './payouts-error.filter';
import {
  PLATFORM_PAYMENTS_CONFIG,
  PLATFORM_STRIPE_CLIENT,
  PayoutsRuntime,
} from './payouts-runtime.service';
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
 *  - Modo plataforma ENCENDIDO: el webhook único, las rutas del creador, las
 *    dos del contrato del pool (`AdminTenantsPayoutsController`) y el
 *    conciliador de cuentas.
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
   */
  static register(
    config: PlatformPaymentsConfig = getPlatformPaymentsConfig(),
    overrides: { readonly stripe?: PlatformStripeClient } = {},
  ): DynamicModule {
    if (!config.enabled) return { module: PayoutsModule };
    return {
      module: PayoutsModule,
      imports: [AuthModule],
      controllers: [PayoutsController, PlatformWebhookController, AdminTenantsPayoutsController],
      providers: [
        { provide: PLATFORM_PAYMENTS_CONFIG, useValue: config },
        {
          provide: PLATFORM_STRIPE_CLIENT,
          useFactory: () =>
            overrides.stripe ?? new FetchPlatformStripeClient({ secretKey: config.secretKey }),
        },
        PayoutsRuntime,
        PayoutsAccountsWorker,
        { provide: APP_FILTER, useClass: PayoutsErrorFilter },
      ],
      exports: [PayoutsRuntime],
    };
  }
}
