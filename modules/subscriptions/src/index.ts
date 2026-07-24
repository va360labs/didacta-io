/**
 * Punto de entrada del módulo mod.subscriptions.
 *
 * Exporta:
 *   - manifest declarativo (parseado).
 *   - Service principal y sus tipos públicos.
 *   - Adapter de Stripe + interfaz para mockear.
 *   - Errores de dominio para que apps/api los mapee a HTTP.
 *   - Factory `buildSubscriptionsModule(service)` para registrar contra el
 *     ModuleRegistry del CORE.
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';
import { SubscriptionsService } from './subscriptions.service.js';

export { manifest };
export { SubscriptionsService, DEFAULT_GRACE_PERIOD_DAYS } from './subscriptions.service.js';
export type {
  SubscriptionsEventPublisher,
  CheckoutUrlBuilder,
  StartSubscriptionInput,
  StartSubscriptionResult,
} from './subscriptions.service.js';
export {
  MembershipService,
  MEMBERSHIP_EVENT,
  PLAN_INTERVALS,
  stripHtmlToExcerpt,
} from './membership.service.js';
export type {
  PlanInput,
  MembershipConfigInput,
  MembershipCourseView,
  MembershipPublicPage,
  MembershipPublicStats,
  UserProvisioner,
} from './membership.service.js';
export { SubscriptionsStripeSdkAdapter } from './stripe-subscriptions.client.js';
export type {
  SubscriptionsStripeAdapter,
  CreateSubscriptionCheckoutParams,
  CreateRecurringPriceParams,
  StripeSubscriptionCheckoutResult,
  StripePriceResult,
  StripeSubscriptionView,
} from './stripe-subscriptions.client.js';
export {
  SubscriptionsError,
  SubscriptionNotFoundError,
  SubscriptionAlreadyActiveError,
  SubscriptionPriceNotRecurringError,
  SubscriptionAccessDeniedError,
  WebhookSignatureInvalidError,
  StripeConfigMissingError,
  StripeApiError,
  MembershipPlanNotFoundError,
  MembershipPageInactiveError,
  MembershipConfigIncompleteError,
  MembershipNotTrialingError,
} from './errors.js';

export function buildSubscriptionsModule(_service: SubscriptionsService): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.subscriptions: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.subscriptions: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.subscriptions: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.subscriptions: onUninstall', { tenantId });
    },
  };
}
