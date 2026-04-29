import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export {
  rubricCriterionSchema,
  upsertRubricSchema,
  suggestForAttemptSchema,
  type CriterionScoreView,
  type RubricCriterionDto,
  type RubricView,
  type SuggestForAttemptDto,
  type SuggestForAttemptResultView,
  type SuggestionView,
  type UpsertRubricDto,
} from './dto.js';
export {
  AiGraderError,
  AttemptNotPendingReviewError,
  GraderProviderError,
  GraderResponseParseError,
  QuestionNotGradableError,
  RubricInvalidError,
  RubricNotFoundError,
  SuggestionNotFoundError,
} from './errors.js';
export {
  buildGraderPrompt,
  parseGraderResponse,
  type BuildGraderPromptInput,
  type BuiltGraderPrompt,
  type ParsedGraderResponse,
} from './prompt-builder.js';
export { AiGraderRubricService } from './rubric.service.js';
export { AiGraderSuggestionService, type ChatFn } from './suggestion.service.js';

export const aiGraderModule: DidactaModule = {
  manifest,
  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.ai-grader: onRegister', { name: manifest.name });
  },
  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.ai-grader: onEnable', { tenantId });
  },
  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.ai-grader: onDisable', { tenantId });
  },
  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.ai-grader: onUninstall', { tenantId });
  },
};
