/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export {
  CHALLENGE_RULE_KEY,
  DEFAULT_RULES,
  GAMIFICATION_EVENT,
  GamificationService,
  dayStartUtc,
  rangeStartUtc,
  type AwardResult,
  type ChallengeView,
  type GamificationEventPublisher,
  type LeaderboardRange,
  type LeaderboardRow,
  type LevelView,
  type MyPerkView,
  type PerkRequestStatus,
  type PerkRequestView,
  type PerkView,
  type RuleView,
  type SubmissionView,
} from './gamification.service.js';
export {
  GamificationAlreadyReviewedError,
  GamificationAlreadySubmittedError,
  GamificationChallengeClosedError,
  GamificationConflictError,
  GamificationError,
  GamificationNotFoundError,
  GamificationPerkUnavailableError,
  GamificationValidationError,
} from './errors.js';

/**
 * Módulo mod.gamification (bloque 1 — puntos, niveles y retos).
 *
 * El consumo de eventos de otros módulos NO vive aquí sino en un bridge del
 * host (`apps/api/src/modules/gamification/gamification-events.bridge.ts`),
 * igual que en mod.surveys: el emisor no debe conocer al consumidor, y la
 * composición cross-módulo es responsabilidad del host (ADR-016).
 */
export function buildGamificationModule(): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.gamification: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.gamification: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.gamification: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.gamification: onUninstall', { tenantId });
    },
  };
}
