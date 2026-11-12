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
  sharesOfGross,
  chargeToSettlement,
} from './money.js';
export type {
  ComputeSplitInput,
  Split,
  ProportionalReversalInput,
  SettledSaleAmounts,
  GrossShares,
} from './money.js';

export { LedgerService, IDEMPOTENCY_KEYS, isSettlementEntryKey } from './ledger.service.js';
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

export { handleChargeEvent, SETTLEMENT_TRIGGER_EVENT_TYPES } from './handlers/charge.js';
export type { ChargeEventOutcome } from './handlers/charge.js';
export { checkTransferEvent, TRANSFER_EVENT_TYPES } from './handlers/transfer.js';
export type { TransferCheckOutcome } from './handlers/transfer.js';

// E5 — membresías: factura cobrada → venta; hijos de la sesión; portal del creador.
export {
  PAYOUTS_RENEWAL_ON_BLOCKED_ACCOUNT_ALERT,
  accountHoldsRenewals,
  recordInvoiceSale,
} from './handlers/invoice.js';
export type { InvoiceSaleInput, InvoiceSaleOutcome } from './handlers/invoice.js';
export { SUBSCRIPTION_REF_SOURCES, registerSubscriptionChildren } from './handlers/subscription.js';
export type { SubscriptionChildrenOutcome } from './handlers/subscription.js';
export {
  findInvoiceOfCharge,
  findInvoicePayment,
  invoicePaymentFromObject,
} from './stripe/invoice-shape.js';
export type { InvoicePaymentRef } from './stripe/invoice-shape.js';
export { PayoutsPortalService } from './portal.service.js';
export type { PortalForAccount } from './portal.service.js';

export {
  PAYOUTS_ALERTS,
  SALE_FAILURE_REASONS,
  SALE_HOLD_REASONS,
  SettlementService,
  awaitingFeeBackoffMs,
  saleReasonCode,
} from './settlement.service.js';
export type {
  SaleFailureReason,
  SaleHoldReason,
  SettleOutcome,
  SettleSweepResult,
  SettlementServiceOptions,
} from './settlement.service.js';

export { PayoutsReconcilerService } from './reconciler.service.js';
export type {
  InvariantViolation,
  ReconcileOptions,
  ReconcileReport,
  ReconcilerDeps,
} from './reconciler.service.js';

export {
  DEFAULT_LOSS_POLICY,
  PAYOUTS_LOSS_ALERTS,
  SILENT_NOTIFIER,
  isInsufficientFunds,
  reverseTransfer,
  reversibleBalance,
} from './losses.js';
export type {
  PayoutsLossPolicy,
  PayoutsNotifier,
  ReversalResult,
  ReversalStatus,
} from './losses.js';

export {
  PayoutsDebtsService,
  createDebt,
  frozenDisputeSaleIds,
  wonDisputeFeeDebtIds,
  DISPUTE_WON_FEE_DEBT_PART,
  netAgainstPendingSale,
} from './debts.service.js';
export type {
  CreateDebtInput,
  DebtAlertReport,
  DebtRecoveryReport,
  DebtView,
  DebtsServiceOptions,
} from './debts.service.js';

export { PayoutsRefundsService } from './refunds.service.js';
export type {
  RefundAccountingOutcome,
  RefundPreview,
  RefundResult,
  RefundsServiceOptions,
} from './refunds.service.js';

export { PayoutsDisputesService } from './disputes.service.js';
export type {
  DisputeSyncOutcome,
  DisputeView,
  DisputesServiceOptions,
} from './disputes.service.js';

export { PayoutsOffboardingService } from './offboarding.service.js';
export type { DisconnectResult } from './offboarding.service.js';

export { handleRefundEvent, REFUND_EVENT_TYPES } from './handlers/refund.js';
export type { RefundEventOutcome } from './handlers/refund.js';
export { handleDisputeEvent, DISPUTE_EVENT_TYPES } from './handlers/dispute.js';
export type { DisputeEventOutcome } from './handlers/dispute.js';

export { PayoutsReportsService, estimatePayoutDate } from './reports.service.js';
export type {
  CurrencySummary,
  SaleView,
  SalesPage,
  SalesSummary,
  VolumeRow,
} from './reports.service.js';

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
  PayoutsSettlementConflictError,
  PayoutsSaleNotFoundError,
  PayoutsSaleNotRefundableError,
  PayoutsRefundExceedsRemainingError,
  PayoutsRefundRejectedError,
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
