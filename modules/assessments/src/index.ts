import type { LearnShipModule, ModuleContext } from '@learnship/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { AssessmentsService } from './assessments.service.js';
export {
  createOptionSchema,
  createQuestionSchema,
  createQuizSchema,
  questionTypeSchema,
  startAttemptSchema,
  submitAttemptAnswerSchema,
  submitAttemptSchema,
  updateQuizSchema,
  type CreateOptionDto,
  type CreateQuestionDto,
  type CreateQuizDto,
  type QuestionTypeDto,
  type StartAttemptDto,
  type SubmitAttemptAnswerDto,
  type SubmitAttemptDto,
  type UpdateQuizDto,
} from './dto.js';
export {
  AssessmentsError,
  AttemptAlreadySubmittedError,
  AttemptExpiredError,
  AttemptNotFoundError,
  MaxAttemptsReachedError,
  QuestionHasNoCorrectOptionError,
  QuestionNotFoundError,
  QuizHasNoQuestionsError,
  QuizNotFoundError,
  QuizNotPublishedError,
} from './errors.js';
export {
  scoreAttempt,
  type ScoredAnswer,
  type ScoringAnswer,
  type ScoringOption,
  type ScoringQuestion,
  type ScoringQuestionType,
  type ScoringResult,
} from './scoring.js';

export const assessmentsModule: LearnShipModule = {
  manifest,
  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.assessments: onRegister', { name: manifest.name });
  },
  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.assessments: onEnable', { tenantId });
  },
  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.assessments: onDisable', { tenantId });
  },
  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.assessments: onUninstall', { tenantId });
  },
};
