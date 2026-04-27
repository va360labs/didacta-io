import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { ZoomLiveService } from './zoom-live.service.js';
export {
  createSessionSchema,
  sessionStatusSchema,
  updateSessionSchema,
  type CreateSessionDto,
  type SessionStatus,
  type SessionView,
  type UpdateSessionDto,
} from './dto.js';
export {
  CourseNotInTenantError,
  LessonNotInCourseError,
  SessionAlreadyEndedError,
  SessionNotFoundError,
  ZoomApiError,
  ZoomLiveError,
} from './errors.js';
export {
  RealZoomApiClient,
  StubZoomApiClient,
  type ZoomApiClient,
  type ZoomMeetingCreateInput,
  type ZoomMeetingCreateResult,
} from './zoom-api-client.js';

export const zoomLiveModule: DidactaModule = {
  manifest,
  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.zoom-live: onRegister', { name: manifest.name });
  },
  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.zoom-live: onEnable', { tenantId });
  },
  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.zoom-live: onDisable', { tenantId });
  },
  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.zoom-live: onUninstall', { tenantId });
  },
};
