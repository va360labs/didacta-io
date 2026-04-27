import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { LearningService } from './learning.service.js';
export {
  ScormService,
  type ScormPackageMetadata,
  type ScormAttemptState,
} from './scorm.service.js';
export { parseScormManifest, ScormManifestError } from './scorm-parser.js';
export {
  enrollByAdminSchema,
  enrollByCodeSchema,
  enrollByLinkSchema,
  enrollSelfSchema,
  listInvitationsQuerySchema,
  trackProgressSchema,
  createInvitationSchema,
  type EnrollByAdminDto,
  type EnrollByCodeDto,
  type EnrollByLinkDto,
  type EnrollSelfDto,
  type ListInvitationsQueryDto,
  type TrackProgressDto,
  type CreateInvitationDto,
} from './dto.js';
export {
  LearningError,
  AlreadyEnrolledError,
  EnrollmentNotFoundError,
  InvitationInvalidError,
  CourseNotPublishedError,
  ScormLessonTypeMismatchError,
  ScormPackageInvalidError,
  ScormPackageNotFoundError,
} from './errors.js';

export const learningModule: DidactaModule = {
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
