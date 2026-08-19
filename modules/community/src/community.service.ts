/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import type { ModuleContext, NotificationValue } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type {
  AddReactionDto,
  CreateCommentDto,
  CreatePostDto,
  CreateSpaceDto,
  ListPostsQueryDto,
  UpdatePostDto,
  UpdateSpaceDto,
} from './dto.js';
import { flattenPostAttachments, type CommunityAttachment } from './attachments.js';
import {
  CommentNotFoundError,
  NestedRepliesTooDeepError,
  NotAuthorError,
  ParentCommentMismatchError,
  PostNotFoundError,
  ReactionTargetMissingError,
  SpaceAlreadyExistsError,
  SpaceNotDeletableError,
  SpaceNotFoundError,
  TagNameAlreadyExistsError,
  TagNotFoundError,
} from './errors.js';

/**
 * Tope de posts recientes que escanea la Galería para extraer adjuntos.
 * Cota de seguridad para no traer toda la tabla; suficiente para v1.
 */
const ATTACHMENT_POST_SCAN_LIMIT = 1000;

/**
 * CAMINO DEGRADADO NOMBRADO: quien comentó o mencionó no tiene `displayName`.
 *
 * El relleno lo redacta el HUB, no este módulo: la misma mención puede ir a
 * gente que lee en idiomas distintos y aquí no hay forma de saberlo. Antes
 * viajaba «Alguien» ya escrito dentro de `variables`, así que un destinatario
 * `en-US` recibía «Alguien mentioned you in a comment.».
 */
const UNKNOWN_ACTOR_NAME: NotificationValue = {
  hubValue: 'term',
  term: 'community.actor.unknown',
};

/** Destinatario de un lote de aviso masivo. `optedOut` = dado de baja de broadcasts. */
export interface BroadcastRecipient {
  userId: string;
  email: string;
  optedOut: boolean;
}

export class CommunityService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  async createPost(
    tenantId: string,
    author: { id: string; displayName: string | null },
    dto: CreatePostDto,
    /** Origen: 'web' (UI, default) o 'api' (integración con API key). */
    source: 'web' | 'api' = 'web',
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
        source,
      },
    });
    await this.persistMentions(tenantId, author.id, author.displayName, dto.body, {
      postId: post.id,
    });
    await this.publish(tenantId, author.id, 'community.post.created', {
      postId: post.id,
      authorId: author.id,
      courseId: post.courseId,
    });
    return post;
  }

  /**
   * Edita una publicación. Autorizado para el DUEÑO o un moderador (admin).
   * Actualiza title/body/tags (los que vengan) y marca `editedAt` para el
   * indicador "editado". Si cambia el body, re-sincroniza las menciones.
   */
  async updatePost(
    tenantId: string,
    actor: { id: string; canModerate: boolean },
    postId: string,
    patch: UpdatePostDto,
  ) {
    const post = await this.prisma.modCommunityPost.findFirst({
      where: { id: postId, tenantId, deletedAt: null },
    });
    if (!post) throw new PostNotFoundError();
    if (post.authorId !== actor.id && !actor.canModerate) throw new NotAuthorError();

    const updated = await this.prisma.modCommunityPost.update({
      where: { id: postId },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        editedAt: new Date(),
      },
    });
    if (patch.body !== undefined) {
      // A quién ya se avisó antes de reescribir las menciones. Sin esto, cada
      // edición del post volvía a notificar a TODOS los mencionados: corregir
      // tres erratas en un post que menciona a cinco personas les mandaba
      // quince avisos.
      const yaAvisados = new Set(
        (
          await this.prisma.modCommunityMention.findMany({
            where: { tenantId, postId },
            select: { mentionedUserId: true },
          })
        ).map((m) => m.mentionedUserId),
      );
      await this.prisma.modCommunityMention.deleteMany({ where: { tenantId, postId } });
      await this.persistMentions(
        tenantId,
        post.authorId,
        post.authorDisplayName,
        patch.body,
        { postId },
        yaAvisados,
      );
    }
    return updated;
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
    //
    // Pin: los posts fijados van siempre primero ordenados por pinnedAt
    // DESC (el más reciente arriba). `nulls: 'last'` mantiene el resto
    // del orden intacto cuando pinnedAt es null.
    const sort = query.sort ?? 'recent';
    const baseOrder =
      sort === 'oldest'
        ? [{ createdAt: 'asc' as const }]
        : sort === 'most_commented'
          ? [{ comments: { _count: 'desc' as const } }, { createdAt: 'desc' as const }]
          : [{ createdAt: 'desc' as const }];
    const orderBy = [{ pinnedAt: { sort: 'desc' as const, nulls: 'last' as const } }, ...baseOrder];

    return this.prisma.modCommunityPost.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(viewer.canModerate ? {} : { hiddenAt: null }),
        ...(query.courseId !== undefined ? { courseId: query.courseId } : {}),
        ...(query.authorId !== undefined ? { authorId: query.authorId } : {}),
        ...(query.tag !== undefined ? { tags: { has: query.tag } } : {}),
        ...(query.source !== undefined ? { source: query.source } : {}),
      },
      orderBy,
      take: query.limit,
      include: {
        _count: {
          select: { comments: { where: commentVisibilityWhere } },
        },
        // Reacciones del POST (no de los comments). Las traemos completas
        // porque la UI del listado las agrega por emoji y necesita saber
        // si el viewer ya reaccionó (por authorId). Volumen esperado: < 20
        // por post, así que el payload extra es trivial.
        reactions: {
          where: { commentId: null },
        },
      },
    });
  }

  /**
   * Lista los adjuntos (imágenes y archivos) de los posts del tenant para la
   * Galería de comunidad. Si `query.tag` viene, filtra al espacio/tag; si no,
   * agrega todos los espacios (galería global de /comunidad).
   *
   * Los adjuntos no viven en una tabla propia: están serializados en el body
   * de cada post. Escaneamos hasta `ATTACHMENT_POST_SCAN_LIMIT` posts recientes
   * y aplanamos sus adjuntos en memoria. El filtrado fino (tipo, fecha, autor,
   * búsqueda) lo hace el cliente sobre este conjunto.
   *
   * Respeta visibilidad: oculta posts borrados y, salvo moderadores, los
   * ocultos por moderación.
   */
  async listAttachments(
    tenantId: string,
    query: { tag?: string },
    viewer: { canModerate: boolean } = { canModerate: false },
  ): Promise<CommunityAttachment[]> {
    const posts = await this.prisma.modCommunityPost.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(viewer.canModerate ? {} : { hiddenAt: null }),
        ...(query.tag !== undefined ? { tags: { has: query.tag } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: ATTACHMENT_POST_SCAN_LIMIT,
      select: {
        id: true,
        title: true,
        body: true,
        authorId: true,
        authorDisplayName: true,
        createdAt: true,
      },
    });
    return flattenPostAttachments(posts);
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
    // Las reacciones de los COMMENTS tienen postId=null (solo commentId poblado),
    // así que NO entran en `post.reactions` (relación por FK postId). Sin esto, la
    // UI del detalle nunca recibía las reacciones de los comentarios → el contador
    // quedaba a 0 y el toggle "no hacía nada". Las traemos aparte (solo de los
    // comments visibles) y las fusionamos: la UI lee post + comentarios de un único
    // array `reactions`.
    const commentIds = post.comments.map((c) => c.id);
    const commentReactions =
      commentIds.length > 0
        ? await this.prisma.modCommunityReaction.findMany({
            where: { tenantId, commentId: { in: commentIds } },
          })
        : [];
    return { ...post, reactions: [...post.reactions, ...commentReactions] };
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
      select: { id: true, authorId: true, title: true },
    });
    if (!post) throw new PostNotFoundError();

    // Autor del comentario padre (si es una respuesta), para saber a quién avisar.
    let parentAuthorId: string | null = null;

    // Si es una respuesta, validar el comentario padre.
    if (dto.parentCommentId) {
      const parent = await this.prisma.modCommunityComment.findFirst({
        where: { id: dto.parentCommentId, tenantId, deletedAt: null },
        select: { id: true, postId: true, parentCommentId: true, authorId: true },
      });
      if (!parent) throw new CommentNotFoundError();
      if (parent.postId !== postId) throw new ParentCommentMismatchError();
      // 1 nivel máx: el padre no puede ser él mismo una respuesta.
      if (parent.parentCommentId !== null) throw new NestedRepliesTooDeepError();
      parentAuthorId = parent.authorId;
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
    await this.persistMentions(tenantId, author.id, author.displayName, dto.body, {
      commentId: comment.id,
    });
    await this.notifyCommentTarget({
      tenantId,
      author,
      post: { id: post.id, authorId: post.authorId, title: post.title },
      comment: { id: comment.id, body: dto.body, parentCommentId: comment.parentCommentId },
      parentAuthorId,
    });
    await this.publish(tenantId, author.id, 'community.comment.created', {
      commentId: comment.id,
      postId,
      authorId: author.id,
      parentCommentId: comment.parentCommentId,
    });
    return comment;
  }

  /**
   * Avisa al destinatario de un comentario nuevo:
   *  - Comentario raíz → autor del post ("comentaron en tu publicación").
   *  - Respuesta       → autor del comentario padre ("respondieron a tu comentario").
   *
   * Regla: nunca te notificás a vos mismo. Este aviso ("comentaron/respondieron")
   * es el importante para el destinatario y lleva email, así que se envía SIEMPRE
   * aunque el comentario además lo @mencione — la mención es una señal aparte.
   *
   * Se envía por in-app y email; el hub respeta la matriz de preferencias del
   * usuario (categoría COMMUNITY) y omite el canal que el usuario deshabilitó.
   * Best-effort: un fallo de notificación no rompe la creación del comentario.
   */
  private async notifyCommentTarget(args: {
    tenantId: string;
    author: { id: string; displayName: string | null };
    post: { id: string; authorId: string; title: string };
    comment: { id: string; body: string; parentCommentId: string | null };
    parentAuthorId: string | null;
  }): Promise<void> {
    const isReply = args.comment.parentCommentId !== null;
    const recipient = isReply ? args.parentAuthorId : args.post.authorId;
    if (!recipient) return;
    if (recipient === args.author.id) return; // no auto-notificación

    const variables = {
      actorId: args.author.id,
      actorName: args.author.displayName ?? UNKNOWN_ACTOR_NAME,
      postId: args.post.id,
      postTitle: args.post.title,
      commentId: args.comment.id,
      parentCommentId: args.comment.parentCommentId,
      excerpt: excerpt(args.comment.body),
    };
    const templateKey = isReply ? 'community.reply.to_comment' : 'community.comment.on_post';

    for (const channel of ['in-app', 'email'] as const) {
      await this.ctx.notificationHub
        .send({
          tenantId: args.tenantId,
          channel,
          templateKey,
          // Sin `locale`: el hub resuelve el idioma de cada destinatario.
          to: recipient,
          category: 'COMMUNITY',
          variables,
        })
        .catch((err: unknown) => {
          this.ctx.logger.warn('mod.community: notify comment target failed', {
            tenantId: args.tenantId,
            recipient,
            channel,
            templateKey,
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }
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

  // -------------------- tags admin --------------------

  async listTags(tenantId: string) {
    return this.prisma.modCommunityTag.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
  }

  async createTag(
    tenantId: string,
    actorId: string,
    dto: { name: string; color: string; icon?: string | null },
  ) {
    const name = dto.name.trim().toLowerCase();
    const collision = await this.prisma.modCommunityTag.findUnique({
      where: { tenantId_name: { tenantId, name } },
    });
    if (collision) throw new TagNameAlreadyExistsError(name);
    const tag = await this.prisma.modCommunityTag.create({
      data: {
        id: randomUUID(),
        tenantId,
        name,
        color: dto.color,
        icon: dto.icon ?? null,
      },
    });
    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'community.tag.created',
      resourceType: 'community_tag',
      resourceId: tag.id,
      metadata: { name, color: dto.color, icon: dto.icon ?? null },
    });
    return tag;
  }

  async updateTag(
    tenantId: string,
    actorId: string,
    tagId: string,
    dto: { name?: string; color?: string; icon?: string | null },
  ) {
    const existing = await this.prisma.modCommunityTag.findFirst({
      where: { id: tagId, tenantId },
    });
    if (!existing) throw new TagNotFoundError(tagId);
    const tag = await this.prisma.modCommunityTag.update({
      where: { id: tagId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim().toLowerCase() } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      },
    });
    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'community.tag.updated',
      resourceType: 'community_tag',
      resourceId: tag.id,
      metadata: dto,
    });
    return tag;
  }

  async deleteTag(tenantId: string, actorId: string, tagId: string) {
    const existing = await this.prisma.modCommunityTag.findFirst({
      where: { id: tagId, tenantId },
    });
    if (!existing) throw new TagNotFoundError(tagId);
    await this.prisma.modCommunityTag.delete({ where: { id: tagId } });
    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'community.tag.deleted',
      resourceType: 'community_tag',
      resourceId: tagId,
      metadata: { name: existing.name },
    });
  }

  // -------------------- pin admin --------------------

  /**
   * Fija un post al tope del feed. Solo super_admin / tenant_admin (el
   * caller debe verificar el rol). Idempotente: si el post ya está
   * fijado, refresca el `pinnedAt` para que vuelva al primer puesto entre
   * los pinneados.
   */
  async pinPost(tenantId: string, moderatorId: string, postId: string) {
    const post = await this.prisma.modCommunityPost.findFirst({
      where: { id: postId, tenantId, deletedAt: null },
    });
    if (!post) throw new PostNotFoundError();
    const updated = await this.prisma.modCommunityPost.update({
      where: { id: postId },
      data: { pinnedAt: new Date(), pinnedById: moderatorId },
    });
    await this.ctx.auditLog.record({
      tenantId,
      actorId: moderatorId,
      action: 'community.post.pinned',
      resourceType: 'post',
      resourceId: postId,
      metadata: { title: post.title },
    });
    return updated;
  }

  async unpinPost(tenantId: string, moderatorId: string, postId: string) {
    const post = await this.prisma.modCommunityPost.findFirst({
      where: { id: postId, tenantId, deletedAt: null },
    });
    if (!post) throw new PostNotFoundError();
    const updated = await this.prisma.modCommunityPost.update({
      where: { id: postId },
      data: { pinnedAt: null, pinnedById: null },
    });
    await this.ctx.auditLog.record({
      tenantId,
      actorId: moderatorId,
      action: 'community.post.unpinned',
      resourceType: 'post',
      resourceId: postId,
      metadata: { title: post.title },
    });
    return updated;
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
    authorDisplayName: string | null,
    body: string,
    target: { postId?: string; commentId?: string },
    /**
     * Mencionados a los que ya se avisó en una versión anterior del texto. Se
     * les vuelve a crear la fila (la mención sigue existiendo) pero NO se les
     * vuelve a notificar.
     */
    yaAvisados: Set<string> = new Set(),
  ): Promise<Set<string>> {
    const handles = parseMentionHandles(body);
    if (handles.length === 0) return new Set();

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

    if (rowsToCreate.length === 0) return new Set();

    await this.prisma.modCommunityMention.createMany({ data: rowsToCreate });

    // Notifica vía NotificationHub al mencionado (in-app + email si está configurado).
    for (const m of rowsToCreate) {
      if (yaAvisados.has(m.mentionedUserId)) continue; // ya se le avisó de esta mención
      await this.ctx.notificationHub
        .send({
          tenantId,
          channel: 'in-app',
          templateKey: 'community.mention',
          // Sin `locale`: el hub resuelve el idioma de cada destinatario.
          to: m.mentionedUserId,
          variables: {
            authorId,
            authorName: authorDisplayName ?? UNKNOWN_ACTOR_NAME,
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

    // Devuelve los destinatarios ya avisados por mención, para que el aviso de
    // "comentaron/respondieron" no los duplique.
    return new Set(rowsToCreate.map((m) => m.mentionedUserId));
  }

  // ── Avisos masivos (broadcast) ─────────────────────────────────────────────

  /**
   * Crea un aviso masivo a TODOS los miembros ACTIVE del tenant. Calcula el
   * total de destinatarios (para el progreso) y deja el registro en PENDING; el
   * worker lo procesa por lotes. `postId` != null si nace de publicar un post.
   */
  async createBroadcast(
    tenantId: string,
    createdById: string,
    input: { subject: string; bodyText: string; important?: boolean; postId?: string | null },
  ) {
    const total = await this.prisma.user.count({ where: { tenantId, status: 'ACTIVE' } });
    return this.prisma.modCommunityBroadcast.create({
      data: {
        tenantId,
        createdById,
        subject: input.subject,
        bodyText: input.bodyText,
        important: input.important ?? false,
        postId: input.postId ?? null,
        status: 'PENDING',
        total,
      },
    });
  }

  /** Registro de un aviso del tenant (o null). */
  async getBroadcast(tenantId: string, id: string) {
    return this.prisma.modCommunityBroadcast.findFirst({ where: { id, tenantId } });
  }

  /** Últimos avisos del tenant (para el panel de estado). */
  async listBroadcasts(tenantId: string, limit = 20) {
    return this.prisma.modCommunityBroadcast.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Toma el siguiente lote de destinatarios de un aviso (usuarios ACTIVE con
   * `id > cursor`, orden asc por id). Marca RUNNING en el primer lote y DONE
   * cuando ya no quedan. Devuelve cada destinatario con su flag de baja para que
   * el worker decida a quién enviar (los `important` ignoran la baja). NO avanza
   * el cursor — eso lo hace `commitBroadcastBatch` tras enviar (resumible).
   */
  async claimBroadcastBatch(broadcastId: string, batchSize: number) {
    const b = await this.prisma.modCommunityBroadcast.findUnique({ where: { id: broadcastId } });
    if (!b || b.status === 'DONE' || b.status === 'FAILED') {
      return { broadcast: b, recipients: [] as BroadcastRecipient[], done: true };
    }
    if (b.status === 'PENDING') {
      await this.prisma.modCommunityBroadcast.update({
        where: { id: b.id },
        data: { status: 'RUNNING', startedAt: new Date() },
      });
    }
    const users = await this.prisma.user.findMany({
      where: {
        tenantId: b.tenantId,
        status: 'ACTIVE',
        ...(b.cursorUserId ? { id: { gt: b.cursorUserId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, email: true },
    });
    if (users.length === 0) {
      await this.prisma.modCommunityBroadcast.update({
        where: { id: b.id },
        data: { status: 'DONE', finishedAt: new Date() },
      });
      return { broadcast: b, recipients: [] as BroadcastRecipient[], done: true };
    }
    const optedOut = await this.prisma.modCommunityUserPref.findMany({
      where: {
        tenantId: b.tenantId,
        userId: { in: users.map((u) => u.id) },
        broadcastOptOut: true,
      },
      select: { userId: true },
    });
    const optedSet = new Set(optedOut.map((o) => o.userId));
    const recipients: BroadcastRecipient[] = users.map((u) => ({
      userId: u.id,
      email: u.email,
      optedOut: optedSet.has(u.id),
    }));
    return { broadcast: b, recipients, done: false };
  }

  /** Suma contadores y avanza el cursor tras enviar un lote. */
  async commitBroadcastBatch(
    broadcastId: string,
    delta: { sent: number; failed: number; skipped: number; lastUserId: string },
  ) {
    await this.prisma.modCommunityBroadcast.update({
      where: { id: broadcastId },
      data: {
        sent: { increment: delta.sent },
        failed: { increment: delta.failed },
        skipped: { increment: delta.skipped },
        cursorUserId: delta.lastUserId,
      },
    });
  }

  /** Marca (o quita) la baja de avisos masivos de un usuario. Para el unsubscribe. */
  async setBroadcastOptOut(tenantId: string, userId: string, value: boolean) {
    await this.prisma.modCommunityUserPref.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, broadcastOptOut: value },
      update: { broadcastOptOut: value },
    });
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

  // ── Espacios de comunidad ──────────────────────────────────────────────────

  /** Lista los espacios del tenant ordenados por sortOrder. */
  async listSpaces(tenantId: string) {
    return this.prisma.modCommunitySpace.findMany({
      where: { tenantId },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        icon: true,
        color: true,
        sortOrder: true,
        isSystem: true,
      },
    });
  }

  /** Crea un espacio. Rechaza slug duplicado en el tenant. */
  async createSpace(tenantId: string, createdById: string, dto: CreateSpaceDto) {
    const existing = await this.prisma.modCommunitySpace.findUnique({
      where: { tenantId_slug: { tenantId, slug: dto.slug } },
    });
    if (existing) throw new SpaceAlreadyExistsError(dto.slug);
    return this.prisma.modCommunitySpace.create({
      data: {
        tenantId,
        slug: dto.slug,
        title: dto.title,
        description: dto.description ?? null,
        icon: dto.icon ?? '#',
        color: dto.color ?? 'var(--didacta-trust)',
        sortOrder: dto.sortOrder ?? 0,
        createdById,
      },
    });
  }

  /** Edita un espacio existente (parcial). */
  async updateSpace(tenantId: string, slug: string, dto: UpdateSpaceDto) {
    const space = await this.prisma.modCommunitySpace.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
    });
    if (!space) throw new SpaceNotFoundError(slug);
    return this.prisma.modCommunitySpace.update({
      where: { tenantId_slug: { tenantId, slug } },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });
  }

  /** Elimina un espacio. Bloqueado si es de sistema o tiene publicaciones. */
  async deleteSpace(tenantId: string, slug: string) {
    const space = await this.prisma.modCommunitySpace.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
    });
    if (!space) throw new SpaceNotFoundError(slug);
    if (space.isSystem) {
      throw new SpaceNotDeletableError(
        `El espacio '${slug}' es de sistema y no se puede eliminar.`,
      );
    }
    const postCount = await this.prisma.modCommunityPost.count({
      where: { tenantId, tags: { has: slug }, deletedAt: null },
    });
    if (postCount > 0) {
      throw new SpaceNotDeletableError(
        `El espacio '${slug}' tiene ${postCount} publicaciones y no se puede eliminar.`,
      );
    }
    await this.prisma.modCommunitySpace.delete({
      where: { tenantId_slug: { tenantId, slug } },
    });
    return { deleted: true };
  }
}

/**
 * Recorta el body de un comentario a un extracto corto para el cuerpo de la
 * notificación (evita meter párrafos enteros en un email/toast). Colapsa
 * saltos de línea y añade elipsis si se truncó.
 */
export function excerpt(body: string, max = 140): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
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
