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
export { ReferralsService, REFERRALS_EVENT, REFERRAL_SCOPES, utcDay } from './referrals.service.js';
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
} from './referrals.service.js';
export {
  ReferralsError,
  ReferralsProgramInactiveError,
  ReferralsMembershipRequiredError,
  ReferralsCommissionNotFoundError,
  ReferralsCommissionStateError,
  ReferralsPayoutValidationError,
  ReferralsConfigValidationError,
} from './errors.js';

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
