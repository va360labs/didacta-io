/**
 * Punto de entrada del módulo mod.payment-connections.
 *
 * Exporta:
 *   - manifest declarativo (parseado).
 *   - Service principal y sus tipos/puertos públicos.
 *   - Cliente Stripe read-only + interfaz para mockear.
 *   - Errores de dominio para que apps/api los mapee a HTTP.
 *   - Factory `buildPaymentConnectionsModule(service)` para registrar contra el
 *     ModuleRegistry del CORE.
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';
import { PaymentConnectionsService } from './payment-connections.service.js';

export { manifest };
export { PaymentTiersService } from './tiers.service.js';
export type {
  UserTierView,
  DerivedTierEntry,
  CreateTierInput,
  UpdateTierInput,
} from './tiers.service.js';
export {
  PaymentConnectionsService,
  PAYMENT_CONNECTIONS_MODULE,
  STRIPE_ACTIVE_STATUSES,
  DEFAULT_MAX_PAGES,
  SUPPORTED_PROVIDERS,
  normalizeEmail,
} from './payment-connections.service.js';
export type {
  ConfigPort,
  UserDirectoryPort,
  DidactaUserRecord,
  PaymentReadAdapterFactory,
  PaymentCredentials,
  StripeCredentials,
  PayPalCredentials,
  WooCommerceCredentials,
  AddConnectionInput,
  ReconcileResult,
  MemberSubscriptionMatch,
} from './payment-connections.service.js';
export { StripeReadSdkAdapter } from './stripe-reader.client.js';
export type {
  StripeReadAdapter,
  StripeAccountInfo,
  StripeSubscriberRecord,
  StripeSubscriptionsResult,
  ListActiveSubscriptionsOptions,
} from './stripe-reader.client.js';
export { PayPalReadSdkAdapter } from './paypal-reader.client.js';
export type { PayPalReaderCredentials } from './paypal-reader.client.js';
export { WooCommerceReadSdkAdapter } from './woocommerce-reader.client.js';
export type { WooCommerceReaderCredentials } from './woocommerce-reader.client.js';
export {
  PaymentConnectionsError,
  PaymentConnectionNotFoundError,
  PaymentConnectionAlreadyExistsError,
  PaymentConnectionProviderNotSupportedError,
  StripeReadKeyInvalidError,
  StripeReadApiError,
  TierNotFoundError,
  TierNameConflictError,
} from './errors.js';

export function buildPaymentConnectionsModule(_service: PaymentConnectionsService): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.payment-connections: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.payment-connections: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.payment-connections: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.payment-connections: onUninstall', { tenantId });
    },
  };
}
