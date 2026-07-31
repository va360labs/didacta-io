/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export {
  askSchema,
  indexCourseSchema,
  listAnswersSchema,
  monthlyReportSchema,
  reviewAnswerSchema,
  upsertCorrectionSchema,
  REVIEW_STATUSES,
  type AskDto,
  type AskResponseView,
  type ChunkView,
  type CitationView,
  type CorrectionView,
  type IndexCourseDto,
  type IndexCourseResultView,
  type ListAnswersDto,
  type ListAnswersResultView,
  type MonthlyReportDto,
  type MonthlyReportView,
  type ReportTopicView,
  type ReviewAnswerDto,
  type ReviewAnswerView,
  type ReviewStatus,
  type UpsertCorrectionDto,
} from './dto.js';
export {
  AiTutorError,
  ChatProviderError,
  CorrectionNotFoundError,
  CourseNotIndexedError,
  CourseNotPublishedError,
  EmbeddingsProviderError,
  MessageNotFoundError,
  TokenQuotaExceededError,
} from './errors.js';
export {
  clusterQuestions,
  cosineSimilarity,
  formatVector,
  parseVector,
  type ClusterableQuestion,
  type ClusterOptions,
  type QuestionCluster,
} from './clustering.js';
export { AiTutorReviewService, rangoDelMes } from './review.service.js';
export { chunkText, type Chunk, type ChunkerOptions } from './chunker.js';
export {
  extractLessonText,
  type ExtractInput,
  type ExtractResult,
  type LessonType,
} from './lesson-extractor.js';
export { AiTutorIndexerService, type EmbedFn, type IndexCourseOptions } from './indexer.service.js';
export { AiTutorChatService, type ChatFn } from './chat.service.js';
export {
  buildPrompt,
  extractCitations,
  trimHistoryToBudget,
  type BuildPromptInput,
  type BuiltPrompt,
  type ParsedCitation,
  type PriorMessage,
  type RetrievedChunk,
  type ValidatedAnswer,
} from './prompt-builder.js';

export const aiTutorModule: DidactaModule = {
  manifest,
  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.ai-tutor: onRegister', { name: manifest.name });
  },
  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.ai-tutor: onEnable', { tenantId });
  },
  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.ai-tutor: onDisable', { tenantId });
  },
  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.ai-tutor: onUninstall', { tenantId });
  },
};
