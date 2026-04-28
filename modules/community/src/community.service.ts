import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type { AddReactionDto, CreateCommentDto, CreatePostDto, ListPostsQueryDto } from './dto.js';
import {
  CommentNotFoundError,
  NestedRepliesTooDeepError,
  NotAuthorError,
  ParentCommentMismatchError,
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
    await this.persistMentions(tenantId, author.id, dto.body, { postId: post.id });
    await this.publish(tenantId, author.id, 'community.post.created', {
      postId: post.id,
      authorId: author.id,
      courseId: post.courseId,
    });
    return post;
  }

  /**
   * Lista posts del tenant. Si `viewer.canModerate` es true (super_admin /
   * tenant_admin), devuelve también los ocultos para que la moderación
   * pueda revisarlos. Resto de usuarios ven solo los visibles.
   */
  async listPosts(
    tenantId: string,
    query: ListPostsQueryDto,
    viewer: { canModerate: boolean } = { canModerate: false },
  ) {
    // Filtro de comentarios alineado con la visibilidad de moderación:
    // los comentarios ocultos solo cuentan para admins. Sin esta cláusula,
    // un alumno vería "5 comentarios" pero al abrir el post solo verá los
    // visibles, generando un mismatch confuso.
    const commentVisibilityWhere = viewer.canModerate
      ? { deletedAt: null }
      : { deletedAt: null, hiddenAt: null };

    // Mapeo del query.sort a Prisma orderBy. `most_commented` ordena por
    // _count.comments DESC y rompe empates por createdAt DESC para que la
    // paginación sea estable. Default 'recent' aplicado acá (el schema lo
    // deja opcional para que callers TS no estén obligados a pasarlo).
    const sort = query.sort ?? 'recent';
    const orderBy =
      sort === 'oldest'
        ? [{ createdAt: 'asc' as const }]
        : sort === 'most_commented'
          ? [{ comments: { _count: 'desc' as const } }, { createdAt: 'desc' as const }]
          : [{ createdAt: 'desc' as const }];

    return this.prisma.modCommunityPost.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(viewer.canModerate ? {} : { hiddenAt: null }),
        ...(query.courseId !== undefined ? { courseId: query.courseId } : {}),
        ...(query.authorId !== undefined ? { authorId: query.authorId } : {}),
        ...(query.tag !== undefined ? { tags: { has: query.tag } } : {}),
      },
      orderBy,
      take: query.limit,
      include: {
        _count: {
          select: { comments: { where: commentVisibilityWhere } },
        },
      },
    });
  }

  async getPostDetail(
    tenantId: string,
    postId: string,
    viewer: { canModerate: boolean } = { canModerate: false },
  ) {
    const post = await this.prisma.modCommunityPost.findFirst({
      where: {
        id: postId,
        tenantId,
        deletedAt: null,
        ...(viewer.canModerate ? {} : { hiddenAt: null }),
      },
      include: {
        comments: {
          where: {
            deletedAt: null,
            ...(viewer.canModerate ? {} : { hiddenAt: null }),
          },
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

    // Si es una respuesta, validar el comentario padre.
    if (dto.parentCommentId) {
      const parent = await this.prisma.modCommunityComment.findFirst({
        where: { id: dto.parentCommentId, tenantId, deletedAt: null },
        select: { id: true, postId: true, parentCommentId: true },
      });
      if (!parent) throw new CommentNotFoundError();
      if (parent.postId !== postId) throw new ParentCommentMismatchError();
      // 1 nivel máx: el padre no puede ser él mismo una respuesta.
      if (parent.parentCommentId !== null) throw new NestedRepliesTooDeepError();
    }

    const comment = await this.prisma.modCommunityComment.create({
      data: {
        tenantId,
        postId,
        authorId: author.id,
        authorDisplayName: author.displayName,
        body: dto.body,
        parentCommentId: dto.parentCommentId ?? null,
      },
    });
    await this.persistMentions(tenantId, author.id, dto.body, { commentId: comment.id });
    await this.publish(tenantId, author.id, 'community.comment.created', {
      commentId: comment.id,
      postId,
      authorId: author.id,
      parentCommentId: comment.parentCommentId,
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
   * Oculta o restaura un post. Solo super_admin / tenant_admin (el caller
   * debe verificar el rol vía decorador o pipe). Si `hidden=true` setea
   * `hiddenAt`, `hiddenById`, `hiddenReason`. Si `hidden=false` los limpia.
   */
  async moderatePost(
    tenantId: string,
    moderatorId: string,
    postId: string,
    args: { hidden: boolean; reason?: string },
  ) {
    const post = await this.prisma.modCommunityPost.findFirst({
      where: { id: postId, tenantId, deletedAt: null },
    });
    if (!post) throw new PostNotFoundError();

    const updated = await this.prisma.modCommunityPost.update({
      where: { id: postId },
      data: args.hidden
        ? {
            hiddenAt: new Date(),
            hiddenById: moderatorId,
            hiddenReason: args.reason ?? null,
          }
        : {
            hiddenAt: null,
            hiddenById: null,
            hiddenReason: null,
          },
    });

    await this.publish(
      tenantId,
      moderatorId,
      args.hidden ? 'community.post.hidden' : 'community.post.unhidden',
      { postId, reason: args.reason ?? null },
    );
    return updated;
  }

  async moderateComment(
    tenantId: string,
    moderatorId: string,
    commentId: string,
    args: { hidden: boolean; reason?: string },
  ) {
    const comment = await this.prisma.modCommunityComment.findFirst({
      where: { id: commentId, tenantId, deletedAt: null },
    });
    if (!comment) throw new CommentNotFoundError();

    const updated = await this.prisma.modCommunityComment.update({
      where: { id: commentId },
      data: args.hidden
        ? {
            hiddenAt: new Date(),
            hiddenById: moderatorId,
            hiddenReason: args.reason ?? null,
          }
        : {
            hiddenAt: null,
            hiddenById: null,
            hiddenReason: null,
          },
    });

    await this.publish(
      tenantId,
      moderatorId,
      args.hidden ? 'community.comment.hidden' : 'community.comment.unhidden',
      { commentId, reason: args.reason ?? null },
    );
    return updated;
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

  /**
   * Busca usuarios del tenant cuyo handle (email antes del `@`) o nombre
   * contiene el prefijo. Limitado a 8 resultados. Usado por el autocomplete
   * de menciones en el frontend.
   *
   * NO devuelve el email completo por privacidad — solo el handle (lo que
   * el autor escribiría tras el `@`) y el displayName.
   */
  async searchTenantUsers(
    tenantId: string,
    prefix: string,
  ): Promise<Array<{ userId: string; handle: string; displayName: string | null }>> {
    if (!prefix || prefix.length < 1) return [];

    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        OR: [
          { email: { startsWith: `${prefix}`, mode: 'insensitive' } },
          { name: { contains: prefix, mode: 'insensitive' } },
        ],
      },
      select: { id: true, email: true, name: true },
      take: 8,
      orderBy: { email: 'asc' },
    });

    return users.map((u) => ({
      userId: u.id,
      handle: u.email.split('@')[0] ?? u.email,
      displayName: u.name ?? null,
    }));
  }

  /**
   * Genera el digest semanal de actividad de un usuario:
   *  - Menciones recibidas desde `since` (createdAt > since).
   *  - Respuestas nuevas (comments con createdAt > since) en hilos donde el
   *    usuario fue autor del post o de algún comment anterior.
   *
   * Devuelve estructuras simples listas para inyectar en una plantilla email.
   * Si no hay nada, ambas listas quedan vacías y el caller decide si vale la
   * pena mandar el email.
   */
  async buildDigest(
    tenantId: string,
    userId: string,
    since: Date,
  ): Promise<{
    mentions: Array<{
      postId: string | null;
      commentId: string | null;
      handle: string;
      authorId: string;
      createdAt: Date;
    }>;
    replies: Array<{
      postId: string;
      commentId: string;
      authorId: string;
      authorDisplayName: string | null;
      bodyExcerpt: string;
      createdAt: Date;
    }>;
  }> {
    const mentionsRows = await this.prisma.modCommunityMention.findMany({
      where: {
        tenantId,
        mentionedUserId: userId,
        createdAt: { gt: since },
      },
      orderBy: { createdAt: 'desc' },
    });
    const mentions = mentionsRows.map((m) => ({
      postId: m.postId,
      commentId: m.commentId,
      handle: m.mentionedHandle,
      authorId: m.authorId,
      createdAt: m.createdAt,
    }));

    // Posts donde el usuario participó (autor del post o autor de un comment).
    const myPostIds = new Set<string>();
    const ownPosts = await this.prisma.modCommunityPost.findMany({
      where: { tenantId, authorId: userId, deletedAt: null, hiddenAt: null },
      select: { id: true },
    });
    for (const p of ownPosts) myPostIds.add(p.id);
    const commentedPosts = await this.prisma.modCommunityComment.findMany({
      where: { tenantId, authorId: userId, deletedAt: null },
      select: { postId: true },
      distinct: ['postId'],
    });
    for (const c of commentedPosts) myPostIds.add(c.postId);

    let replies: Array<{
      postId: string;
      commentId: string;
      authorId: string;
      authorDisplayName: string | null;
      bodyExcerpt: string;
      createdAt: Date;
    }> = [];
    if (myPostIds.size > 0) {
      const newComments = await this.prisma.modCommunityComment.findMany({
        where: {
          tenantId,
          postId: { in: [...myPostIds] },
          createdAt: { gt: since },
          deletedAt: null,
          hiddenAt: null,
          NOT: { authorId: userId }, // no contamos las propias
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      replies = newComments.map((c) => ({
        postId: c.postId,
        commentId: c.id,
        authorId: c.authorId,
        authorDisplayName: c.authorDisplayName,
        bodyExcerpt: c.body.length > 200 ? `${c.body.slice(0, 197)}…` : c.body,
        createdAt: c.createdAt,
      }));
    }

    return { mentions, replies };
  }

  /**
   * Lista los IDs de los users ACTIVE de cada tenant. Útil para el job de
   * digest que itera sobre todos. Limit razonable para evitar OOM si un
   * tenant tiene 100k+ users (raro en este producto).
   */
  async listActiveUsersForDigest(): Promise<Array<{ tenantId: string; userId: string }>> {
    const rows = await this.prisma.user.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, tenantId: true },
      take: 50_000,
    });
    if (rows.length === 0) return [];

    // Filtra los que han optado por NO recibir el digest. Vamos contra la
    // tabla de prefs: si no hay fila, default = recibir (false).
    const optedOut = await this.prisma.modCommunityUserPref.findMany({
      where: { digestOptOut: true, userId: { in: rows.map((r) => r.id) } },
      select: { tenantId: true, userId: true },
    });
    const optedOutKey = new Set(optedOut.map((p) => `${p.tenantId}::${p.userId}`));

    return rows
      .filter((r) => !optedOutKey.has(`${r.tenantId}::${r.id}`))
      .map((r) => ({ tenantId: r.tenantId, userId: r.id }));
  }

  /**
   * Devuelve las preferencias de notificación del usuario. Si nunca tocó
   * ninguna, devuelve los defaults (todo opt-in: digestOptOut = false).
   * No crea fila al leer; solo el upsert de `updateUserPreferences` lo hace.
   */
  async getUserPreferences(tenantId: string, userId: string): Promise<{ digestOptOut: boolean }> {
    const row = await this.prisma.modCommunityUserPref.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    return { digestOptOut: row?.digestOptOut ?? false };
  }

  /**
   * Upsert de las preferencias del usuario. La estructura está pensada
   * para añadir más campos sin migración: solo se actualizan las claves
   * presentes en el patch.
   */
  async updateUserPreferences(
    tenantId: string,
    userId: string,
    patch: { digestOptOut?: boolean },
  ): Promise<{ digestOptOut: boolean }> {
    const row = await this.prisma.modCommunityUserPref.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: {
        id: randomUUID(),
        tenantId,
        userId,
        digestOptOut: patch.digestOptOut ?? false,
      },
      update: {
        ...(patch.digestOptOut !== undefined ? { digestOptOut: patch.digestOptOut } : {}),
      },
    });
    return { digestOptOut: row.digestOptOut };
  }

  /**
   * Devuelve las menciones del usuario, más recientes primero, con el handle
   * y el postId / commentId para que el cliente pueda navegar.
   */
  async listMyMentions(
    tenantId: string,
    userId: string,
    limit: number = 50,
  ): Promise<
    Array<{
      id: string;
      postId: string | null;
      commentId: string | null;
      mentionedHandle: string;
      authorId: string;
      createdAt: Date;
    }>
  > {
    return this.prisma.modCommunityMention.findMany({
      where: { tenantId, mentionedUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // -------------------- helpers --------------------

  /**
   * Parsea el body buscando `@handle`, resuelve cada handle a un user del
   * tenant y persiste filas en `mod_community_mention`. Best-effort: si una
   * mención no resuelve a un usuario real, se ignora silenciosamente.
   *
   * Handle = todo lo que está antes del `@` en el email (ej. juan@x.com → "juan").
   * Si dos usuarios del tenant tienen el mismo handle, se usa el primero
   * encontrado por orden alfabético de email — caso raro pero documentado.
   */
  private async persistMentions(
    tenantId: string,
    authorId: string,
    body: string,
    target: { postId?: string; commentId?: string },
  ): Promise<void> {
    const handles = parseMentionHandles(body);
    if (handles.length === 0) return;

    // Buscamos los users del tenant cuyo email empieza por alguno de los
    // handles (case-insensitive). Una sola query con OR.
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        OR: handles.map((h) => ({
          email: { startsWith: `${h}@`, mode: 'insensitive' },
        })),
      },
      select: { id: true, email: true },
      orderBy: { email: 'asc' },
    });

    // Mapeo handle → primer userId que matchea (evita ambiguity).
    const byHandle = new Map<string, string>();
    for (const u of users) {
      const h = u.email.split('@')[0]?.toLowerCase();
      if (!h || byHandle.has(h)) continue;
      byHandle.set(h, u.id);
    }

    const rowsToCreate = handles
      .map((h) => {
        const userId = byHandle.get(h.toLowerCase());
        if (!userId || userId === authorId) return null; // no auto-mention
        return {
          tenantId,
          postId: target.postId ?? null,
          commentId: target.commentId ?? null,
          mentionedUserId: userId,
          mentionedHandle: h,
          authorId,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (rowsToCreate.length === 0) return;

    await this.prisma.modCommunityMention.createMany({ data: rowsToCreate });

    // Notifica vía NotificationHub al mencionado (in-app + email si está configurado).
    for (const m of rowsToCreate) {
      await this.ctx.notificationHub
        .send({
          tenantId,
          channel: 'in-app',
          templateKey: 'community.mention',
          locale: 'es-ES',
          to: m.mentionedUserId,
          variables: {
            authorId,
            postId: m.postId,
            commentId: m.commentId,
            handle: m.mentionedHandle,
          },
        })
        .catch((err: unknown) => {
          this.ctx.logger.warn('mod.community: notify mention failed', {
            tenantId,
            mentionedUserId: m.mentionedUserId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

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

/**
 * Extrae handles únicos del body. Reconoce `@handle` precedido por inicio de
 * línea, espacio o un caracter de puntuación común. Permite letras, números,
 * `_`, `.`, `-`. Devuelve handles deduplicados en orden de aparición.
 */
export function parseMentionHandles(body: string): string[] {
  const matches = body.matchAll(/(?:^|[\s(.,;:!?[\]{}<>])@([A-Za-z0-9._-]+)/g);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const handle = m[1];
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
  }
  return out;
}
