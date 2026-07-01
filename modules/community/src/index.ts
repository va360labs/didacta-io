import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { CommunityService, type BroadcastRecipient } from './community.service.js';
export {
  parseBodyAttachments,
  flattenPostAttachments,
  type AttachmentImage,
  type AttachmentFile,
  type CommunityAttachment,
  type PostForAttachments,
} from './attachments.js';
export {
  addReactionSchema,
  COMMUNITY_TAG_ICONS,
  createBroadcastSchema,
  createCommentSchema,
  createPostSchema,
  createSpaceSchema,
  createTagSchema,
  listPostsQuerySchema,
  moderationActionSchema,
  postSortSchema,
  updatePostSchema,
  updateSpaceSchema,
  updateTagSchema,
  userPreferencesSchema,
  type AddReactionDto,
  type CreateBroadcastDto,
  type CreateCommentDto,
  type CreatePostDto,
  type CreateSpaceDto,
  type CreateTagDto,
  type ListPostsQueryDto,
  type ModerationActionDto,
  type PostSort,
  type UpdatePostDto,
  type UpdateSpaceDto,
  type UpdateTagDto,
  type UserPreferencesDto,
} from './dto.js';
export {
  CommentNotFoundError,
  CommunityError,
  NestedRepliesTooDeepError,
  NotAuthorError,
  NotModeratorError,
  ParentCommentMismatchError,
  PostNotFoundError,
  ReactionTargetMissingError,
  SpaceAlreadyExistsError,
  SpaceNotDeletableError,
  SpaceNotFoundError,
  TagNameAlreadyExistsError,
  TagNotFoundError,
} from './errors.js';

export const communityModule: DidactaModule = {
  manifest,
  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.community: onRegister', { name: manifest.name });
  },
  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.community: onEnable', { tenantId });
  },
  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.community: onDisable', { tenantId });
  },
  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.community: onUninstall', { tenantId });
  },
};
