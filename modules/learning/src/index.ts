import type { LearnShipModule, ModuleContext } from '@learnship/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { LearningService } from './learning.service.js';
export {
  enrollByAdminSchema,
  enrollByCodeSchema,
  enrollByLinkSchema,
  trackProgressSchema,
  createInvitationSchema,
  type EnrollByAdminDto,
  type EnrollByCodeDto,
  type EnrollByLinkDto,
  type TrackProgressDto,
  type CreateInvitationDto,
} from './dto.js';
export {
  LearningError,
  AlreadyEnrolledError,
  EnrollmentNotFoundError,
  InvitationInvalidError,
  CourseNotPublishedError,
} from './errors.js';

export const learningModule: LearnShipModule = {
  manifest,
  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.learning: onRegister', { name: manifest.name });
  },
  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.learning: onEnable', { tenantId });
  },
  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.learning: onDisable', { tenantId });
  },
  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.learning: onUninstall', { tenantId });
  },
};
