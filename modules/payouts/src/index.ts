/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Punto de entrada del módulo mod.payouts (cobros de plataforma).
 *
 * Exporta:
 *   - manifest declarativo (parseado).
 *   - Aritmética del dinero (`computeSplit`, reversión proporcional…).
 *   - LedgerService (libro de solo inserción) y RefsService (objeto → tenant).
 *   - Cliente de Stripe de plataforma: interfaz, implementación sobre `fetch`
 *     y doble en memoria para tests.
 *   - Verificación de firma de webhook con varios secretos.
 *   - Errores de dominio para que apps/api los mapee a HTTP.
 *   - Factory `buildPayoutsModule()` para registrar contra el ModuleRegistry
 *     del CORE. En E1 nadie la llama todavía: el host la registrará cuando
 *     existan los endpoints (E2), y solo con el modo plataforma encendido.
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };

export {
  DEFAULT_FEE_BPS,
  MAX_FEE_BPS,
  BPS_DENOMINATOR,
  MAX_MINOR_AMOUNT,
  assertFeeBps,
  assertMinorAmount,
  assertSignedMinorAmount,
  normalizeCurrency,
  computePlatformFee,
  computeSplit,
  prorate,
  computeProportionalReversal,
  sumMinor,
} from './money.js';
export type { ComputeSplitInput, Split, ProportionalReversalInput } from './money.js';

export { LedgerService, IDEMPOTENCY_KEYS } from './ledger.service.js';
export type {
  LedgerEntry,
  LedgerEntryInput,
  AppendLedgerResult,
  LedgerBalance,
} from './ledger.service.js';

export { RefsService, OBJECT_REF_KINDS, OBJECT_REF_SOURCES } from './refs.service.js';
export type {
  ObjectRef,
  ObjectRefKind,
  ObjectRefSource,
  RegisterObjectRefInput,
  TenantResolution,
} from './refs.service.js';

export {
  FetchPlatformStripeClient,
  PLATFORM_STRIPE_API_VERSION,
  PLATFORM_STRIPE_V2_API_VERSION,
  STRIPE_API_BASE_URL,
  encodeStripeForm,
  encodeStripeV2Query,
  stripeKeyLivemode,
} from './stripe/platform-stripe.client.js';
export type {
  PlatformStripeClient,
  FetchPlatformStripeClientOptions,
  FetchLike,
  StripeHttpMethod,
  StripeObject,
  StripeParams,
  StripeRequestOptions,
} from './stripe/platform-stripe.client.js';

export {
  ACCOUNT_ENTITY_TYPES,
  EDUCATION_MCC,
  assertStripeAccountId,
  createConnectedAccountsApi,
  defaultCurrencyForCountry,
  isCountryRejection,
  sanitizeStatementDescriptor,
  translateCountryRejection,
} from './stripe/accounts-api.js';
export type {
  AccountEntityType,
  AccountsApiFlavor,
  ConnectedAccountsApi,
  CreateConnectedAccountInput,
  CreatedConnectedAccount,
  StripeBalanceSettings,
  StripeConnectedAccount,
  StripePayoutScheduleV1,
  UpdateBalanceSettingsInput,
} from './stripe/accounts-api.js';

export {
  COUNTRY_NOT_SUPPORTED_REASON,
  PayoutsAccountsService,
  deriveStatus,
  publicBusinessUrl,
  requirementCategory,
  scheduleFromAccount,
} from './accounts.service.js';
export type {
  AccountToSync,
  DerivedAccountStatus,
  OnboardingPrefill,
  OnboardingUrls,
  PayoutScheduleView,
  PayoutsAccountView,
  PayoutsAccountsConfig,
  PayoutsAccountsServiceOptions,
  PayoutsDbPort,
  PayoutsLogger,
  PayoutsPayoutInterval,
  PayoutsRequirementCategory,
  PayoutsTx,
} from './accounts.service.js';

export {
  accountIdOfEvent,
  isAccountEvent,
  minimalEventPayload,
  parsePlatformEvent,
} from './account-events.js';
export type { PlatformStripeEvent } from './account-events.js';

export {
  idOf,
  resolvePlatformEventTenant,
  routePlatformEvent,
  stripeIdsNamedByEvent,
  subscriptionIdFromInvoice,
} from './event-router.js';
export type {
  PlatformEventAttribution,
  PlatformEventFamily,
  PlatformEventRoute,
} from './event-router.js';

export { recordCheckoutSale } from './handlers/checkout.js';
export type { CheckoutSaleInput, CheckoutSaleOutcome } from './handlers/checkout.js';

export { PayoutsSettingsService } from './settings.service.js';
export type { PayoutsSettingsView } from './settings.service.js';

export { InMemoryPlatformStripeClient } from './stripe/platform-stripe.fake.js';
export type {
  FakeStripeCall,
  FakeStripeHandler,
  FakeStripeRequest,
} from './stripe/platform-stripe.fake.js';

export {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeSignature,
  assertStripeSignature,
  signStripePayload,
} from './stripe/signature.js';
export type {
  SignatureFailureReason,
  SignatureVerification,
  VerifyStripeSignatureParams,
} from './stripe/signature.js';

export {
  PayoutsError,
  PayoutsInvalidAmountError,
  PayoutsInvalidFeeBpsError,
  PayoutsInvalidCurrencyError,
  PayoutsInvalidIdempotencyKeyError,
  PayoutsInvalidObjectRefError,
  PayoutsWebhookSignatureInvalidError,
  PayoutsObjectRefConflictError,
  PayoutsLedgerIdempotencyConflictError,
  PayoutsCountryUnsupportedError,
  PayoutsInvalidEntityTypeError,
  PayoutsAccountNotFoundError,
  PayoutsAccountAlreadyStartedError,
  PayoutsAccountOnboardingIncompleteError,
  PayoutsWebhookPayloadInvalidError,
  PayoutsWebhookLivemodeMismatchError,
  PayoutsNotReadyError,
  PayoutsSaleUnrecordableError,
  PlatformStripeConfigError,
  PlatformStripeApiError,
} from './errors.js';
export type { PayoutsErrorOptions, PlatformStripeApiErrorInfo } from './errors.js';

/**
 * Factory del módulo. No recibe servicios todavía: en E1 el módulo no consume
 * ni emite eventos, así que los hooks de ciclo de vida solo dejan traza.
 */
export function buildPayoutsModule(): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.payouts: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.payouts: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.payouts: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.payouts: onUninstall', { tenantId });
    },
  };
}
