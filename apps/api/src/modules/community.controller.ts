import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  addReactionSchema,
  createCommentSchema,
  createPostSchema,
  listPostsQuerySchema,
  moderationActionSchema,
  NotModeratorError,
  type AddReactionDto,
  type CreateCommentDto,
  type CreatePostDto,
  type ListPostsQueryDto,
  type ModerationActionDto,
} from '@didacta/mod-community';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import type { SessionClaims } from '../auth/token.service';
import { CommunityDigestWorker } from './community-digest.worker';
import { ModuleRegistryService } from './module-registry.service';

@ApiTags('Modules · Community')
@ApiBearerAuth()
@Controller('modules/community')
@UseGuards(JwtAuthGuard)
export class CommunityController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly digest: CommunityDigestWorker,
  ) {}

  private async authorOf(user: SessionClaims): Promise<{ id: string; displayName: string | null }> {
    // Resolvemos displayName del User una sola vez por request. Si el user no
    // existe (edge case), caemos a null.
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { name: true, email: true },
    });
    return {
      id: user.sub,
      displayName: dbUser?.name ?? dbUser?.email ?? null,
    };
  }

  @Post('posts')
  @ApiOperation({ summary: 'Crear post' })
  async createPost(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createPostSchema)) dto: CreatePostDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const author = await this.authorOf(user);
    return this.registry.getCommunityService().createPost(user.tenantId, author, dto);
  }

  @Get('posts')
  @ApiOperation({ summary: 'Listar posts del tenant (filtrable por courseId / authorId / tag)' })
  async listPosts(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listPostsQuerySchema)) query: ListPostsQueryDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getCommunityService()
      .listPosts(user.tenantId, query, { canModerate: canModerate(user) });
  }

  @Get('posts/:id')
  @ApiOperation({ summary: 'Detalle del post (incluye comments + reactions)' })
  async getPost(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getCommunityService()
      .getPostDetail(user.tenantId, id, { canModerate: canModerate(user) });
  }

  @Delete('posts/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Soft-delete del post (solo el autor)' })
  async deletePost(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    await this.registry.getCommunityService().deletePost(user.tenantId, user.sub, id);
    return { deleted: true };
  }

  @Post('posts/:id/comments')
  @ApiOperation({ summary: 'Añadir comentario al post' })
  async addComment(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createCommentSchema)) dto: CreateCommentDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const author = await this.authorOf(user);
    return this.registry.getCommunityService().addComment(user.tenantId, id, author, dto);
  }

  @Delete('comments/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Soft-delete del comentario (solo el autor)' })
  async deleteComment(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    await this.registry.getCommunityService().deleteComment(user.tenantId, user.sub, id);
    return { deleted: true };
  }

  @Post('reactions')
  @ApiOperation({ summary: 'Añadir reacción a post o comment (idempotente por author + emoji)' })
  async addReaction(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(addReactionSchema)) dto: AddReactionDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getCommunityService().addReaction(user.tenantId, user.sub, dto);
  }

  @Delete('reactions/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Eliminar mi reacción (idempotente sobre missing)' })
  async removeReaction(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    await this.registry.getCommunityService().removeReaction(user.tenantId, user.sub, id);
    return { deleted: true };
  }

  @Get('users/search')
  @ApiOperation({
    summary:
      'Busca usuarios del tenant por prefijo (handle = email antes del @, o nombre). Usado por el autocomplete de menciones. Hasta 8 resultados.',
  })
  async searchUsers(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(z.object({ prefix: z.string().min(1).max(64) })))
    q: { prefix: string },
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getCommunityService().searchTenantUsers(user.tenantId, q.prefix);
  }

  @Get('mentions/me')
  @ApiOperation({
    summary: 'Lista las últimas menciones recibidas por el usuario actual.',
  })
  async listMyMentions(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getCommunityService().listMyMentions(user.tenantId, user.sub);
  }

  @Post('digest/run-now')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Encola un job de digest semanal manual para todos los usuarios. Solo super_admin (test/QA).',
  })
  async runDigestNow(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.includes('super_admin')) {
      throw new UnauthorizedException('Solo super_admin puede disparar el digest manualmente.');
    }
    await this.digest.triggerNow();
    return { enqueued: true };
  }

  @Post('posts/:id/moderate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ocultar o restaurar un post. Solo super_admin / tenant_admin.',
  })
  async moderatePost(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(moderationActionSchema)) dto: ModerationActionDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    return this.registry.getCommunityService().moderatePost(user.tenantId, user.sub, id, dto);
  }

  @Post('comments/:id/moderate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ocultar o restaurar un comentario. Solo super_admin / tenant_admin.',
  })
  async moderateComment(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(moderationActionSchema)) dto: ModerationActionDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    return this.registry.getCommunityService().moderateComment(user.tenantId, user.sub, id, dto);
  }
}

const MODERATOR_ROLES = new Set(['super_admin', 'tenant_admin']);

function canModerate(user: SessionClaims): boolean {
  return user.roles.some((r) => MODERATOR_ROLES.has(r));
}
