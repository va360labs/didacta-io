import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { CommunityService } from './community.service.js';
export {
  addReactionSchema,
  createCommentSchema,
  createPostSchema,
  listPostsQuerySchema,
  type AddReactionDto,
  type CreateCommentDto,
  type CreatePostDto,
  type ListPostsQueryDto,
} from './dto.js';
export {
  CommentNotFoundError,
  CommunityError,
  NotAuthorError,
  PostNotFoundError,
  ReactionTargetMissingError,
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
