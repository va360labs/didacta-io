/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export {
  AiContentService,
  type ChatFn,
  type LessonTextResolver,
  type DraftEventPublisher,
  type GenerateDraftInput,
  type UpdateDraftContentInput,
  type ListDraftsFilter,
  type DraftType,
  type DraftStatus,
  type DraftContent,
  type SummaryContent,
  type FlashcardsContent,
  type QuizContent,
} from './ai-content.service.js';
export { parseModelJson } from './json-parser.js';
export {
  AiContentError,
  DraftNotFoundError,
  DraftNotInDraftStateError,
  LessonTextEmptyError,
  AiContentProviderError,
  AiContentTruncatedError,
  InvalidContentJsonError,
} from './errors.js';

/**
 * Factory: el service se construye en apps/api porque depende de Prisma,
 * AI Gateway (chatFn) y el resolver de lección. mod.ai-content solo emite
 * eventos — onRegister es no-op más allá del logging, igual que mod.billing.
 */
import { AiContentService } from './ai-content.service.js';

export function buildAiContentModule(_service: AiContentService): DidactaModule {
  return {
    manifest,
    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.ai-content: onRegister', { name: manifest.name });
    },
    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.ai-content: onEnable', { tenantId });
    },
    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.ai-content: onDisable', { tenantId });
    },
    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.ai-content: onUninstall', { tenantId });
    },
  };
}
