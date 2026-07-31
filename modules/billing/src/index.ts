/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Punto de entrada del módulo mod.billing.
 *
 * Exporta:
 *  - manifest declarativo (parseado).
 *  - Service principal y sus tipos públicos.
 *  - Adapter de Stripe (default + interfaz para mockear).
 *  - Errores de dominio para que apps/api los mapee a HTTP.
 *  - Factory `buildBillingModule(service)` que el bootstrap registra contra
 *    el ModuleRegistry del CORE.
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';
import { BillingService } from './billing.service.js';

export { manifest };
export { BillingService };
export type {
  BillingEventPublisher,
  CheckoutUrlBuilder,
  CreateProductInput,
  UpdateProductInput,
  StartCheckoutInput,
  StartCheckoutResult,
} from './billing.service.js';
export { StripeSdkAdapter } from './stripe.client.js';
export type {
  StripeAdapter,
  CreateCheckoutSessionParams,
  StripeCheckoutSessionResult,
  StripePriceResult,
  StripeProductResult,
} from './stripe.client.js';
export {
  BillingError,
  ProductNotFoundError,
  ProductAlreadyExistsError,
  ProductInactiveError,
  OrderNotFoundError,
  WebhookSignatureInvalidError,
  StripeConfigMissingError,
  StripeApiError,
} from './errors.js';

/**
 * Factory cableado al service. El service se construye en el bootstrap
 * (apps/api/src/bootstrap o similar) porque depende de Prisma y del adapter
 * de Stripe — dos dependencias que el module-kernel no puede resolver solo.
 *
 * Patrón idéntico al de `mod.certificates`: handler de eventos vive aquí
 * cuando el módulo CONSUME un evento. mod.billing solo EMITE — por tanto
 * onRegister es un no-op más allá del logging.
 */
export function buildBillingModule(_service: BillingService): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.billing: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.billing: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.billing: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.billing: onUninstall', { tenantId });
    },
  };
}
