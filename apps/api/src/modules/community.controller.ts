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
  type AddReactionDto,
  type CreateCommentDto,
  type CreatePostDto,
  type ListPostsQueryDto,
} from '@didacta/mod-community';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

@ApiTags('Modules · Community')
@ApiBearerAuth()
@Controller('modules/community')
@UseGuards(JwtAuthGuard)
export class CommunityController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
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
    return this.registry.getCommunityService().listPosts(user.tenantId, query);
  }

  @Get('posts/:id')
  @ApiOperation({ summary: 'Detalle del post (incluye comments + reactions)' })
  async getPost(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getCommunityService().getPostDetail(user.tenantId, id);
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
}
