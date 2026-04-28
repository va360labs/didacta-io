import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { CommunityService } from './community.service.js';
export {
  addReactionSchema,
  COMMUNITY_TAG_ICONS,
  createCommentSchema,
  createPostSchema,
  createTagSchema,
  listPostsQuerySchema,
  moderationActionSchema,
  postSortSchema,
  updateTagSchema,
  userPreferencesSchema,
  type AddReactionDto,
  type CreateCommentDto,
  type CreatePostDto,
  type CreateTagDto,
  type ListPostsQueryDto,
  type ModerationActionDto,
  type PostSort,
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
