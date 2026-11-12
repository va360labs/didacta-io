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
