import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { AssessmentsService } from './assessments.service.js';
export {
  createOptionSchema,
  createQuestionSchema,
  createQuizSchema,
  gradeAnswerSchema,
  gradeAttemptSchema,
  questionTypeSchema,
  startAttemptSchema,
  submitAttemptAnswerSchema,
  submitAttemptSchema,
  updateQuizSchema,
  type CreateOptionDto,
  type CreateQuestionDto,
  type CreateQuizDto,
  type GradeAnswerDto,
  type GradeAttemptDto,
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
  AttemptNotPendingReviewError,
  GradeExceedsQuestionPointsError,
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

export const assessmentsModule: DidactaModule = {
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
