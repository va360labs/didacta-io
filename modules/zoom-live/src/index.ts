import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { ZoomLiveService } from './zoom-live.service.js';
export {
  createSessionSchema,
  listWebhookEventsQuerySchema,
  sessionStatusSchema,
  updateSessionSchema,
  webhookEventSchema,
  type CreateSessionDto,
  type ListWebhookEventsQuery,
  type PaginatedWebhookEvents,
  type RegistrationView,
  type SessionStatus,
  type SessionView,
  type SessionViewer,
  type UpdateSessionDto,
  type WebhookEventView,
  type ZoomWebhookEvent,
} from './dto.js';
export {
  CourseNotInTenantError,
  InvalidWebhookSignatureError,
  LessonNotInCourseError,
  SessionAlreadyEndedError,
  SessionNotFoundError,
  SessionNotOpenForRegistrationError,
  ZoomApiError,
  ZoomLiveError,
} from './errors.js';
export { verifyZoomSignature } from './webhook-signature.js';
export {
  buildZoomApiClient,
  RealZoomApiClient,
  StubZoomApiClient,
  type ZoomApiClient,
  type ZoomMeetingCreateInput,
  type ZoomMeetingCreateResult,
  type ZoomS2SCredentials,
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
