/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Punto de entrada del módulo mod.referrals.
 *
 * Exporta:
 *   - manifest declarativo (parseado).
 *   - ReferralsService y sus tipos públicos.
 *   - Errores de dominio para que apps/api los mapee a HTTP.
 *   - Factory `buildReferralsModule(service)` para registrar contra el
 *     ModuleRegistry del CORE.
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';
import { ReferralsService } from './referrals.service.js';

export { manifest };
export {
  ReferralsService,
  REFERRALS_EVENT,
  REFERRAL_SCOPES,
  purchaseInvoiceRef,
  utcDay,
  CREDIT_MAX_SHARE_BPS,
  creditIdempotencyKey,
  uncreditIdempotencyKey,
  netAgainstAdjustments,
  REFERRAL_TERMS_VERSION,
  REFERRAL_CREDIT_LABEL,
} from './referrals.service.js';
export type {
  ReferralsEventPublisher,
  UserEmailLookup,
  ReferralScope,
  ReferralsConfigView,
  ReferralsConfigInput,
  AttributeInput,
  AttributeResult,
  AccrueInput,
  AccrueResult,
  PurchaseInput,
  PurchaseResult,
  ReferralsCreditPort,
  MemberCreditView,
  ReferralsPublicTerms,
  ReferralsCipher,
} from './referrals.service.js';
export { deriveInviteeState, initialsOf } from './invitees.js';
export type { InviteeState, InviteeFacts } from './invitees.js';
export {
  ReferralsError,
  ReferralsProgramInactiveError,
  ReferralsMembershipRequiredError,
  ReferralsCommissionNotFoundError,
  ReferralsCommissionStateError,
  ReferralsPayoutValidationError,
  ReferralsConfigValidationError,
  ReferralsCreditDisabledError,
  ReferralsCreditNothingError,
  ReferralsCreditUnavailableError,
  ReferralsCreditFailedError,
  ReferralsTermsRequiredError,
  ReferralsPayeeInvalidError,
  ReferralsPayeeRequiredError,
  ReferralsPayoutAlreadyRequestedError,
  ReferralsPayoutNotFoundError,
  ReferralsPayeeUnavailableError,
} from './errors.js';
export {
  normalizePayee,
  isValidIban,
  isValidSpanishTaxId,
  maskIban,
  maskTaxId,
  formatIban,
  PayeeValidationError,
} from './payee.js';
export type { PayeeDetails, PayeeField } from './payee.js';
export {
  renderReceiptPdf,
  receiptLabel,
  receiptSecondLang,
  formatReceiptAmount,
  toReceiptLang,
} from './receipt-pdf.js';
export type { ReceiptPdfInput, ReceiptLine, ReceiptLang } from './receipt-pdf.js';

export function buildReferralsModule(_service: ReferralsService): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.referrals: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.referrals: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.referrals: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.referrals: onUninstall', { tenantId });
    },
  };
}
