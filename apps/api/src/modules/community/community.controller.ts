/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  addReactionSchema,
  createBroadcastSchema,
  createCommentSchema,
  createPostSchema,
  createSpaceSchema,
  createTagSchema,
  listPostsQuerySchema,
  moderationActionSchema,
  NotModeratorError,
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
  type UpdatePostDto,
  type UpdateSpaceDto,
  type UpdateTagDto,
  type UserPreferencesDto,
} from '@didacta/mod-community';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import type { SessionClaims } from '../../auth/token.service';
import { CommunityDigestWorker } from './community-digest.worker';
import { CommunityBroadcastWorker } from './community-broadcast.worker';
import { ModuleRegistryService } from '../module-registry.service';

const listAttachmentsQuerySchema = z.object({
  tag: z.string().min(1).max(40).optional(),
});

@ApiTags('Modules · Community')
@ApiBearerAuth()
@Controller('modules/community')
@UseGuards(JwtAuthGuard)
export class CommunityController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly digest: CommunityDigestWorker,
    private readonly broadcast: CommunityBroadcastWorker,
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
  @ApiOperation({
    summary: 'Crear post. Con `notifyAll` (solo admins) avisa por email + campana a todos.',
  })
  async createPost(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createPostSchema)) dto: CreatePostDto,
  ) {
    if (!user) throw new UnauthorizedException();
    // El check "avisar a todos" solo lo pueden usar los admins.
    if (dto.notifyAll && !canModerate(user)) throw new NotModeratorError();
    const author = await this.authorOf(user);
    const svc = this.registry.getCommunityService();
    const post = await svc.createPost(user.tenantId, author, dto);
    if (dto.notifyAll) {
      // El body puede llevar el marcador de adjuntos al final; lo recortamos.
      const markerIdx = post.body.indexOf('<!--didacta-attachments:');
      const cleanBody = (markerIdx === -1 ? post.body : post.body.slice(0, markerIdx)).trim();
      const excerpt = cleanBody.slice(0, 600);
      const b = await svc.createBroadcast(user.tenantId, user.sub, {
        subject: post.title,
        bodyText: `${author.displayName ?? 'Un administrador'} ha publicado en la comunidad:\n\n${excerpt}`,
        important: dto.important,
        postId: post.id,
      });
      await this.broadcast.enqueue(b.id);
    }
    return post;
  }

  @Patch('posts/:id')
  @ApiOperation({ summary: 'Editar un post. El dueño o un admin (title/body/tags).' })
  async updatePost(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePostSchema)) dto: UpdatePostDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getCommunityService()
      .updatePost(user.tenantId, { id: user.sub, canModerate: canModerate(user) }, id, dto);
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

  @Get('attachments')
  @ApiOperation({
    summary: 'Listar adjuntos (imágenes y archivos) de los posts, filtrable por espacio/tag',
  })
  async listAttachments(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listAttachmentsQuerySchema)) query: { tag?: string },
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getCommunityService()
      .listAttachments(user.tenantId, query, { canModerate: canModerate(user) });
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

  @Get('me/preferences')
  @ApiOperation({
    summary:
      'Devuelve las preferencias de notificación del usuario (digest opt-out, etc). Defaults si nunca tocó nada.',
  })
  async getMyPreferences(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getCommunityService().getUserPreferences(user.tenantId, user.sub);
  }

  @Put('me/preferences')
  @ApiOperation({
    summary:
      'Actualiza las preferencias de notificación del usuario. Solo se modifican las claves enviadas.',
  })
  async updateMyPreferences(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(userPreferencesSchema)) dto: UserPreferencesDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getCommunityService().updateUserPreferences(user.tenantId, user.sub, dto);
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
      throw new ForbiddenException({
        message: 'Solo super_admin puede disparar el digest manualmente.',
        code: 'COMMUNITY_DIGEST_SUPER_ADMIN_REQUIRED',
      });
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

  @Get('tags')
  @ApiOperation({ summary: 'Listar tags curados del tenant (lectura pública dentro del tenant)' })
  async listTags(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getCommunityService().listTags(user.tenantId);
  }

  @Post('tags')
  @ApiOperation({ summary: 'Crear tag curado. Solo super_admin / tenant_admin.' })
  async createTag(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createTagSchema)) dto: CreateTagDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    return this.registry.getCommunityService().createTag(user.tenantId, user.sub, dto);
  }

  @Put('tags/:id')
  @ApiOperation({ summary: 'Actualizar tag. Solo super_admin / tenant_admin.' })
  async updateTag(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTagSchema)) dto: UpdateTagDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    return this.registry.getCommunityService().updateTag(user.tenantId, user.sub, id, dto);
  }

  @Delete('tags/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Borrar tag. Solo super_admin / tenant_admin.' })
  async deleteTag(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    await this.registry.getCommunityService().deleteTag(user.tenantId, user.sub, id);
    return { deleted: true };
  }

  @Post('posts/:id/pin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Fijar post al tope del feed. Solo super_admin / tenant_admin.' })
  async pinPost(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    return this.registry.getCommunityService().pinPost(user.tenantId, user.sub, id);
  }

  @Post('posts/:id/unpin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Desfijar post. Solo super_admin / tenant_admin.' })
  async unpinPost(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    return this.registry.getCommunityService().unpinPost(user.tenantId, user.sub, id);
  }

  // ── UC-009 ─────────────────────────────────────────────────────────────────

  @Get('stats')
  @ApiOperation({ summary: 'Estadísticas públicas del tenant (miembros, cursos activos)' })
  async getStats(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const [members, activeCourses] = await Promise.all([
      this.prisma.user.count({
        where: { tenantId: user.tenantId, deletedAt: null, status: 'ACTIVE' },
      }),
      this.prisma.modCoursesCourse.count({
        where: { tenantId: user.tenantId, status: 'PUBLISHED', deletedAt: null },
      }),
    ]);
    return { members, activeCourses, activeGroups: 0 };
  }

  // ── Espacios ───────────────────────────────────────────────────────────────

  @Get('spaces')
  @ApiOperation({ summary: 'Listar espacios de comunidad del tenant' })
  async listSpaces(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getCommunityService().listSpaces(user.tenantId);
  }

  @Post('spaces')
  @ApiOperation({ summary: 'Crear espacio. Solo super_admin / tenant_admin.' })
  async createSpace(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createSpaceSchema)) dto: CreateSpaceDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    return this.registry.getCommunityService().createSpace(user.tenantId, user.sub, dto);
  }

  @Patch('spaces/:slug')
  @ApiOperation({ summary: 'Editar espacio. Solo super_admin / tenant_admin.' })
  async updateSpace(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(updateSpaceSchema)) dto: UpdateSpaceDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    return this.registry.getCommunityService().updateSpace(user.tenantId, slug, dto);
  }

  @Delete('spaces/:slug')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Eliminar espacio. Solo admins. Bloqueado si es sistema o tiene posts.',
  })
  async deleteSpace(@CurrentUser() user: SessionClaims | undefined, @Param('slug') slug: string) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    return this.registry.getCommunityService().deleteSpace(user.tenantId, slug);
  }

  // ── UC-010 ─────────────────────────────────────────────────────────────────

  @Get('members')
  @ApiOperation({ summary: 'Directorio público de miembros del tenant (paginado)' })
  async listCommunityMembers(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('page') pageStr?: string,
    @Query('limit') limitStr?: string,
    @Query('search') search?: string,
  ) {
    if (!user) throw new UnauthorizedException();
    const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(limitStr ?? '20', 10) || 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId: user.tenantId,
      deletedAt: null,
      status: 'ACTIVE' as const,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [members, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          roles: { select: { role: { select: { name: true } } } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      members: members.map((m) => ({
        id: m.id,
        displayName: m.name,
        avatarUrl: m.avatarUrl,
        roles: m.roles.map((r) => r.role.name),
      })),
      total,
    };
  }

  // ── Avisos masivos (broadcast) — solo admins ───────────────────────────────

  @Post('broadcasts')
  @ApiOperation({
    summary:
      'Crear y encolar un aviso masivo a todos los miembros. Solo super_admin / tenant_admin.',
  })
  async createBroadcast(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createBroadcastSchema)) dto: CreateBroadcastDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    const b = await this.registry.getCommunityService().createBroadcast(user.tenantId, user.sub, {
      subject: dto.subject,
      bodyText: dto.bodyText,
      important: dto.important,
    });
    await this.broadcast.enqueue(b.id);
    return b;
  }

  @Get('broadcasts')
  @ApiOperation({ summary: 'Listar los últimos avisos masivos con su estado. Solo admins.' })
  async listBroadcasts(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    if (!canModerate(user)) throw new NotModeratorError();
    return this.registry.getCommunityService().listBroadcasts(user.tenantId);
  }
}

const MODERATOR_ROLES = new Set(['super_admin', 'tenant_admin']);

function canModerate(user: SessionClaims): boolean {
  return user.roles.some((r) => MODERATOR_ROLES.has(r));
}
