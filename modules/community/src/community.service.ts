import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@learnship/core-kernel';
import type { PrismaClient } from '@learnship/database';
import type { AddReactionDto, CreateCommentDto, CreatePostDto, ListPostsQueryDto } from './dto.js';
import {
  CommentNotFoundError,
  NotAuthorError,
  PostNotFoundError,
  ReactionTargetMissingError,
} from './errors.js';

export class CommunityService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  async createPost(
    tenantId: string,
    author: { id: string; displayName: string | null },
    dto: CreatePostDto,
  ) {
    const post = await this.prisma.modCommunityPost.create({
      data: {
        tenantId,
        authorId: author.id,
        authorDisplayName: author.displayName,
        title: dto.title,
        body: dto.body,
        courseId: dto.courseId ?? null,
        tags: dto.tags ?? [],
      },
    });
    await this.publish(tenantId, author.id, 'community.post.created', {
      postId: post.id,
      authorId: author.id,
      courseId: post.courseId,
    });
    return post;
  }

  async listPosts(tenantId: string, query: ListPostsQueryDto) {
    return this.prisma.modCommunityPost.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(query.courseId !== undefined ? { courseId: query.courseId } : {}),
        ...(query.authorId !== undefined ? { authorId: query.authorId } : {}),
        ...(query.tag !== undefined ? { tags: { has: query.tag } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
  }

  async getPostDetail(tenantId: string, postId: string) {
    const post = await this.prisma.modCommunityPost.findFirst({
      where: { id: postId, tenantId, deletedAt: null },
      include: {
        comments: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
        },
        reactions: true,
      },
    });
    if (!post) throw new PostNotFoundError();
    return post;
  }

  async deletePost(tenantId: string, actorId: string, postId: string) {
    const post = await this.prisma.modCommunityPost.findFirst({
      where: { id: postId, tenantId, deletedAt: null },
    });
    if (!post) throw new PostNotFoundError();
    if (post.authorId !== actorId) throw new NotAuthorError();
    await this.prisma.modCommunityPost.update({
      where: { id: postId },
      data: { deletedAt: new Date() },
    });
  }

  async addComment(
    tenantId: string,
    postId: string,
    author: { id: string; displayName: string | null },
    dto: CreateCommentDto,
  ) {
    const post = await this.prisma.modCommunityPost.findFirst({
      where: { id: postId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!post) throw new PostNotFoundError();

    const comment = await this.prisma.modCommunityComment.create({
      data: {
        tenantId,
        postId,
        authorId: author.id,
        authorDisplayName: author.displayName,
        body: dto.body,
      },
    });
    await this.publish(tenantId, author.id, 'community.comment.created', {
      commentId: comment.id,
      postId,
      authorId: author.id,
    });
    return comment;
  }

  async deleteComment(tenantId: string, actorId: string, commentId: string) {
    const comment = await this.prisma.modCommunityComment.findFirst({
      where: { id: commentId, tenantId, deletedAt: null },
    });
    if (!comment) throw new CommentNotFoundError();
    if (comment.authorId !== actorId) throw new NotAuthorError();
    await this.prisma.modCommunityComment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Idempotente: si el author ya reaccionó a ese target con ese emoji, no
   * duplica la fila (vuelve la existente).
   */
  async addReaction(tenantId: string, actorId: string, dto: AddReactionDto) {
    const targets = [dto.postId, dto.commentId].filter((x): x is string => Boolean(x));
    if (targets.length !== 1) throw new ReactionTargetMissingError();

    if (dto.postId) {
      const existing = await this.prisma.modCommunityReaction.findFirst({
        where: { tenantId, postId: dto.postId, authorId: actorId, emoji: dto.emoji },
      });
      if (existing) return existing;
      const created = await this.prisma.modCommunityReaction.create({
        data: {
          tenantId,
          postId: dto.postId,
          authorId: actorId,
          emoji: dto.emoji,
        },
      });
      await this.publish(tenantId, actorId, 'community.reaction.added', {
        reactionId: created.id,
        target: 'post',
        targetId: dto.postId,
        emoji: dto.emoji,
      });
      return created;
    }

    const commentId = dto.commentId!;
    const existing = await this.prisma.modCommunityReaction.findFirst({
      where: { tenantId, commentId, authorId: actorId, emoji: dto.emoji },
    });
    if (existing) return existing;
    const created = await this.prisma.modCommunityReaction.create({
      data: {
        tenantId,
        commentId,
        authorId: actorId,
        emoji: dto.emoji,
      },
    });
    await this.publish(tenantId, actorId, 'community.reaction.added', {
      reactionId: created.id,
      target: 'comment',
      targetId: commentId,
      emoji: dto.emoji,
    });
    return created;
  }

  async removeReaction(tenantId: string, actorId: string, reactionId: string) {
    const reaction = await this.prisma.modCommunityReaction.findFirst({
      where: { id: reactionId, tenantId },
    });
    if (!reaction) return; // idempotente
    if (reaction.authorId !== actorId) throw new NotAuthorError();
    await this.prisma.modCommunityReaction.delete({ where: { id: reactionId } });
  }

  // -------------------- helpers --------------------

  private async publish(
    tenantId: string,
    actorId: string,
    name: string,
    data: Record<string, unknown>,
  ) {
    await this.ctx.eventBus.publish({
      name,
      version: 1,
      data,
      metadata: {
        tenantId,
        userId: actorId,
        timestamp: new Date().toISOString(),
        traceId: randomUUID(),
        idempotencyKey: `${name}:${JSON.stringify(data)}:${Date.now()}`,
      },
    });
  }
}
