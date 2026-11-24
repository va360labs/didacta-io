/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import type { ModuleContext, NotificationValue } from '@didacta/core-kernel';
import { eventIdempotencyKey } from '@didacta/core-kernel';
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
  AccessGroupUnknownError,
  CommentNotFoundError,
  NestedRepliesTooDeepError,
  NotAuthorError,
  ParentCommentMismatchError,
  PostNotFoundError,
  ReactionTargetMissingError,
  SpaceAlreadyExistsError,
  SpaceLockedError,
  SpaceNotDeletableError,
  SpaceNotFoundError,
  TagNameAlreadyExistsError,
  TagNotFoundError,
} from './errors.js';
import {
  NO_ACCESS_GROUPS,
  SpaceAccess,
  type AccessGroupMembership,
  type AccessLevel,
  type SpaceViewer,
} from './space-access.js';

/**
 * Tope de posts recientes que escanea la Galería para extraer adjuntos.
 * Cota de seguridad para no traer toda la tabla; suficiente para v1.
 */
const ATTACHMENT_POST_SCAN_LIMIT = 1000;

/** «Últimos comentarios» de la barra lateral: cuántos por defecto y como mucho. */
const RECENT_COMMENTS_DEFAULT = 3;
const RECENT_COMMENTS_MAX = 10;
/** Largo del extracto de cada comentario en la barra lateral. */
const RECENT_COMMENT_EXCERPT = 100;

/** Un comentario reciente, listo para la barra lateral del feed. */
export interface RecentComment {
  id: string;
  postId: string;
  postTitle: string;
  authorId: string;
  authorDisplayName: string | null;
  /** Una línea, sin el marcador de adjuntos. Puede quedar vacío (solo adjuntos). */
  excerpt: string;
  createdAt: Date;
}

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

/**
 * Quién se ha dado de baja de los correos de la comunidad (resumen semanal y
 * avisos masivos). Hay dos marcas por historia —`digestOptOut` la pone el
 * interruptor «Comunidad · Email» de /account, `broadcastOptOut` el enlace de
 * baja de un correo—, pero para quien las pone son UNA decisión: «no me
 * escribáis». Cualquiera de las dos corta los dos correos.
 *
 * Con cada marca cortando solo lo suyo, quien pulsaba «darse de baja» en un
 * aviso seguía recibiendo el resumen cada semana, y quien apagaba el
 * interruptor de /account seguía recibiendo los avisos.
 */
const COMMUNITY_EMAIL_OPT_OUT = {
  OR: [{ digestOptOut: true }, { broadcastOptOut: true }],
};

/**
 * Cuenta a la que se le puede escribir: activa y NO eliminada. `deletedAt` va
 * aparte de `status` porque hay borrados que no tocan el estado (el de un
 * módulo vía `ctx.didacta.users`), y a una cuenta eliminada no se le manda nada.
 */
const WRITABLE_ACCOUNT = { status: 'ACTIVE', deletedAt: null } as const;

/**
 * Destinatario de un lote de aviso masivo. `optedOut` = dado de baja de los
 * correos de la comunidad (por cualquiera de las dos marcas). `canSee` = puede
 * ver la publicación del aviso: si está en un espacio con nivel que no tiene,
 * el aviso no se le manda (ni se cuenta).
 */
export interface BroadcastRecipient {
  userId: string;
  email: string;
  optedOut: boolean;
  canSee: boolean;
}

/**
 * Quien mira la comunidad. `canModerate` (admin) ve además lo oculto por
 * moderación; `seesAllSpaces` (equipo del aula: admin o formador) ve los
 * espacios con nivel. Sin `userId` y sin ser equipo no se ve nada restringido.
 */
export interface CommunityViewer {
  canModerate: boolean;
  userId?: string | null;
  seesAllSpaces?: boolean;
}

/** Un espacio tal como lo ve quien pregunta. */
export interface CommunitySpaceView {
  id: string;
  slug: string;
  title: string;
  /** `null` también cuando el espacio está cerrado para quien mira. */
  description: string | null;
  icon: string;
  color: string;
  sortOrder: number;
  isSystem: boolean;
  /** Cerrado para quien mira: se enseña el nombre y el candado, nada más. */
  locked: boolean;
  /** Niveles con los que se abre (vacío = todos los miembros). */
  accessLevels: AccessLevel[];
  /** Grupos elegidos, tal cual. Solo para el equipo (el editor los necesita). */
  accessGroupIds: string[];
}

function spaceViewerOf(viewer: CommunityViewer): SpaceViewer {
  return {
    userId: viewer.userId ?? null,
    seesEverything: viewer.canModerate || viewer.seesAllSpaces === true,
  };
}

export class CommunityService {
  private readonly access: SpaceAccess;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
    /**
     * Pertenencia a los grupos de acceso, resuelta por el host contra su dueño
     * (mod.access-groups). Sin ella nadie es miembro de nada y los espacios con
     * nivel solo los ve el equipo (falla cerrado).
     */
    membership: AccessGroupMembership = NO_ACCESS_GROUPS,
  ) {
    this.access = new SpaceAccess(prisma, membership);
  }

  /** Slugs de los espacios cerrados para quien mira ([] para el equipo). */
  async blockedSpaceSlugs(tenantId: string, viewer: CommunityViewer): Promise<string[]> {
    return this.access.blockedSlugs(tenantId, spaceViewerOf(viewer));
  }

  /** Rechaza escribir en un espacio cerrado para quien escribe. */
  private async assertTagsWritable(
    tenantId: string,
    viewer: CommunityViewer,
    tags: readonly string[] | undefined,
  ): Promise<void> {
    if (!tags || tags.length === 0) return;
    const blocked = await this.blockedSpaceSlugs(tenantId, viewer);
    if (blocked.length === 0) return;
    const set = new Set(blocked);
    const hit = tags.find((t) => set.has(t) || set.has(t.toLowerCase()));
    if (hit) throw new SpaceLockedError(hit.toLowerCase());
  }

  async createPost(
    tenantId: string,
    author: { id: string; displayName: string | null },
    dto: CreatePostDto,
    /** Origen: 'web' (UI, default) o 'api' (integración con API key). */
    source: 'web' | 'api' = 'web',
    /**
     * Quien publica, para no dejarle escribir en un espacio con nivel que no
     * tiene. Sin él (procesos del sistema, como el anuncio de una clase) no se
     * comprueba: no hay persona a la que cerrarle nada.
     */
    viewer?: CommunityViewer,
  ) {
    if (viewer) await this.assertTagsWritable(tenantId, viewer, dto.tags);
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
    await this.persistMentions(
      tenantId,
      author.id,
      author.displayName,
      dto.body,
      { postId: post.id },
      post.tags,
    );
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
    actor: { id: string; canModerate: boolean; seesAllSpaces?: boolean },
    postId: string,
    patch: UpdatePostDto,
  ) {
    const viewer: CommunityViewer = { ...actor, userId: actor.id };
    const blocked = await this.blockedSpaceSlugs(tenantId, viewer);
    const post = await this.prisma.modCommunityPost.findFirst({
      where: { id: postId, tenantId, deletedAt: null, ...SpaceAccess.postWhere(blocked) },
    });
    if (!post) throw new PostNotFoundError();
    if (post.authorId !== actor.id && !actor.canModerate) throw new NotAuthorError();
    // Mover el post a un espacio cerrado para quien edita tampoco vale.
    if (patch.tags !== undefined) await this.assertTagsWritable(tenantId, viewer, patch.tags);

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
        updated.tags,
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
    viewer: CommunityViewer = { canModerate: false },
  ) {
    // Espacios con nivel que quien mira no tiene: sus posts no salen en
    // ninguna vista (la de «todo» incluida).
    const blocked = await this.blockedSpaceSlugs(tenantId, viewer);
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
        ...SpaceAccess.postWhere(blocked),
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
   * agrega todos los espacios (galería global de /community).
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
    viewer: CommunityViewer = { canModerate: false },
  ): Promise<CommunityAttachment[]> {
    const blocked = await this.blockedSpaceSlugs(tenantId, viewer);
    const posts = await this.prisma.modCommunityPost.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(viewer.canModerate ? {} : { hiddenAt: null }),
        ...(query.tag !== undefined ? { tags: { has: query.tag } } : {}),
        ...SpaceAccess.postWhere(blocked),
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
    viewer: CommunityViewer = { canModerate: false },
  ) {
    // Un post de un espacio cerrado para quien mira responde igual que uno que
    // no existe: 404, sin confirmar nada.
    const blocked = await this.blockedSpaceSlugs(tenantId, viewer);
    const post = await this.prisma.modCommunityPost.findFirst({
      where: {
        id: postId,
        tenantId,
        deletedAt: null,
        ...(viewer.canModerate ? {} : { hiddenAt: null }),
        ...SpaceAccess.postWhere(blocked),
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

  /**
   * Últimos comentarios del aula, con el post al que pertenecen.
   *
   * Alimenta «Últimos comentarios» de la barra lateral del feed: un post de
   * hace semanas con respuestas de hoy no se mueve de su sitio en el feed, y
   * esto es lo que enseña que la comunidad está viva.
   *
   * Solo lo que cualquier miembro puede abrir: nada borrado ni oculto por
   * moderación, ni comentarios visibles dentro de un post oculto. Lo oculto no
   * se promociona aquí ni siquiera para quien modera.
   */
  async listRecentComments(
    tenantId: string,
    limit = RECENT_COMMENTS_DEFAULT,
    /** Quien mira: los comentarios de espacios con nivel que no tiene no salen. */
    viewer: CommunityViewer = { canModerate: false },
  ): Promise<RecentComment[]> {
    const take = Math.min(Math.max(1, Math.trunc(limit) || 1), RECENT_COMMENTS_MAX);
    const blocked = await this.blockedSpaceSlugs(tenantId, viewer);
    const rows = await this.prisma.modCommunityComment.findMany({
      where: {
        tenantId,
        deletedAt: null,
        hiddenAt: null,
        post: { tenantId, deletedAt: null, hiddenAt: null, ...SpaceAccess.postWhere(blocked) },
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        postId: true,
        authorId: true,
        authorDisplayName: true,
        body: true,
        createdAt: true,
        post: { select: { title: true } },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      postId: c.postId,
      postTitle: c.post.title,
      authorId: c.authorId,
      authorDisplayName: c.authorDisplayName,
      excerpt: excerpt(stripAttachmentMarker(c.body), RECENT_COMMENT_EXCERPT),
      createdAt: c.createdAt,
    }));
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
    /** Quien comenta. Por defecto, el autor sin rol de equipo. */
    viewer: CommunityViewer = { canModerate: false, userId: author.id },
  ) {
    // Comentar en un post de un espacio cerrado para quien comenta: 404, como
    // si no existiera.
    const blocked = await this.blockedSpaceSlugs(tenantId, viewer);
    const post = await this.prisma.modCommunityPost.findFirst({
      where: { id: postId, tenantId, deletedAt: null, ...SpaceAccess.postWhere(blocked) },
      select: { id: true, authorId: true, title: true, tags: true },
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
    await this.persistMentions(
      tenantId,
      author.id,
      author.displayName,
      dto.body,
      { commentId: comment.id },
      post.tags,
    );
    await this.notifyCommentTarget({
      tenantId,
      author,
      post: { id: post.id, authorId: post.authorId, title: post.title, tags: post.tags },
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
    post: { id: string; authorId: string; title: string; tags: string[] };
    comment: { id: string; body: string; parentCommentId: string | null };
    parentAuthorId: string | null;
  }): Promise<void> {
    const isReply = args.comment.parentCommentId !== null;
    const recipient = isReply ? args.parentAuthorId : args.post.authorId;
    if (!recipient) return;
    if (recipient === args.author.id) return; // no auto-notificación
    // Quien ya no puede ver el espacio del post (perdió su nivel) no recibe el
    // extracto del comentario por correo ni por la campana.
    const audience = await this.access.audienceForTags(args.tenantId, args.post.tags, [recipient]);
    if (!audience.has(recipient)) return;

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
   *
   * El destino tiene que existir EN ESTE TENANT y no estar borrado. Antes no se
   * comprobaba: se creaban reacciones colgando de un post o comentario borrado
   * —o de otro tenant, porque la FK no sabe de tenants y su comprobación no
   * pasa por RLS—, y se publicaba `community.reaction.added` por ellas. Mismo
   * criterio y mismos códigos (`POST_NOT_FOUND` / `COMMENT_NOT_FOUND`) que
   * `addComment`.
   */
  async addReaction(
    tenantId: string,
    actorId: string,
    dto: AddReactionDto,
    /** Quien reacciona. Por defecto, el actor sin rol de equipo. */
    viewer: CommunityViewer = { canModerate: false, userId: actorId },
  ) {
    const targets = [dto.postId, dto.commentId].filter((x): x is string => Boolean(x));
    if (targets.length !== 1) throw new ReactionTargetMissingError();

    // Reaccionar a algo de un espacio cerrado para quien reacciona: 404.
    const blocked = await this.blockedSpaceSlugs(tenantId, viewer);
    if (dto.postId) {
      const post = await this.prisma.modCommunityPost.findFirst({
        where: { id: dto.postId, tenantId, deletedAt: null, ...SpaceAccess.postWhere(blocked) },
        select: { id: true },
      });
      if (!post) throw new PostNotFoundError();
    } else {
      const comment = await this.prisma.modCommunityComment.findFirst({
        where: { id: dto.commentId!, tenantId, deletedAt: null },
        select: { postId: true },
      });
      if (!comment) throw new CommentNotFoundError();
      // Borrar un post no borra sus comentarios: siguen vivos en la tabla pero
      // el hilo ya no existe. Reaccionar a uno es reaccionar a contenido borrado.
      const thread = await this.prisma.modCommunityPost.findFirst({
        where: {
          id: comment.postId,
          tenantId,
          deletedAt: null,
          ...SpaceAccess.postWhere(blocked),
        },
        select: { id: true },
      });
      if (!thread) throw new CommentNotFoundError();
    }

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
    // El resumen lo lee una persona concreta: lo de los espacios con nivel que
    // no tiene no sale ni como mención ni como respuesta.
    const blocked = await this.access.blockedSlugs(
      tenantId,
      await this.access.viewerOf(tenantId, userId),
    );
    const mentionsRows = await this.visibleMentions(
      tenantId,
      await this.prisma.modCommunityMention.findMany({
        where: {
          tenantId,
          mentionedUserId: userId,
          createdAt: { gt: since },
        },
        orderBy: { createdAt: 'desc' },
      }),
      blocked,
    );
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
          ...(blocked.length > 0 ? { post: SpaceAccess.postWhere(blocked) } : {}),
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
   * Lista los IDs de los users ACTIVE (y no eliminados) de cada tenant. Útil
   * para el job de digest que itera sobre todos. Limit razonable para evitar
   * OOM si un tenant tiene 100k+ users (raro en este producto).
   */
  async listActiveUsersForDigest(): Promise<Array<{ tenantId: string; userId: string }>> {
    const rows = await this.prisma.user.findMany({
      where: { ...WRITABLE_ACCOUNT },
      select: { id: true, tenantId: true },
      take: 50_000,
    });
    if (rows.length === 0) return [];

    // Filtra los que se han dado de baja de los correos de la comunidad. Vamos
    // contra la tabla de prefs: si no hay fila, default = recibir. Cualquiera
    // de las dos marcas vale (ver `COMMUNITY_EMAIL_OPT_OUT`).
    const optedOut = await this.prisma.modCommunityUserPref.findMany({
      where: { ...COMMUNITY_EMAIL_OPT_OUT, userId: { in: rows.map((r) => r.id) } },
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
    // `digestOptOut` es lo que pinta el interruptor «Comunidad · Email» de
    // /account: quien se dio de baja desde el enlace de un correo lo ve apagado,
    // que es exactamente lo que pidió.
    return { digestOptOut: (row?.digestOptOut ?? false) || (row?.broadcastOptOut ?? false) };
  }

  /**
   * Upsert de las preferencias del usuario. La estructura está pensada
   * para añadir más campos sin migración: solo se actualizan las claves
   * presentes en el patch.
   *
   * `digestOptOut` mueve las DOS marcas: el interruptor de /account es «correos
   * de la comunidad», y quien lo apaga no quiere ni el resumen ni los avisos.
   * Con una sola, quien lo apagaba seguía recibiendo avisos — y quien se había
   * dado de baja por enlace no podía volver a darse de alta desde /account.
   */
  async updateUserPreferences(
    tenantId: string,
    userId: string,
    patch: { digestOptOut?: boolean },
  ): Promise<{ digestOptOut: boolean }> {
    const marks =
      patch.digestOptOut !== undefined
        ? { digestOptOut: patch.digestOptOut, broadcastOptOut: patch.digestOptOut }
        : {};
    const row = await this.prisma.modCommunityUserPref.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { id: randomUUID(), tenantId, userId, digestOptOut: false, ...marks },
      update: marks,
    });
    return { digestOptOut: row.digestOptOut || row.broadcastOptOut };
  }

  /**
   * Devuelve las menciones del usuario, más recientes primero, con el handle
   * y el postId / commentId para que el cliente pueda navegar.
   */
  async listMyMentions(
    tenantId: string,
    userId: string,
    limit: number = 50,
    /** Quien pregunta (sus roles). Sin él se resuelve desde la base. */
    viewer?: CommunityViewer,
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
    const blocked = await this.access.blockedSlugs(
      tenantId,
      viewer ? spaceViewerOf({ ...viewer, userId }) : await this.access.viewerOf(tenantId, userId),
    );
    const rows = await this.prisma.modCommunityMention.findMany({
      where: { tenantId, mentionedUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    // Una mención en un espacio con nivel que no tiene (o que perdió) no se
    // enseña: ni el enlace al post ni quién le mencionó.
    return this.visibleMentions(tenantId, rows, blocked);
  }

  /**
   * Quita de una lista de menciones las que caen en posts de espacios
   * cerrados (`blocked`). Las de un comentario se resuelven por su post.
   */
  private async visibleMentions<T extends { postId: string | null; commentId: string | null }>(
    tenantId: string,
    rows: T[],
    blocked: readonly string[],
  ): Promise<T[]> {
    if (blocked.length === 0 || rows.length === 0) return rows;
    const commentIds = rows.map((r) => r.commentId).filter((x): x is string => Boolean(x));
    const comments = commentIds.length
      ? await this.prisma.modCommunityComment.findMany({
          where: { tenantId, id: { in: commentIds } },
          select: { id: true, postId: true },
        })
      : [];
    const postOfComment = new Map(comments.map((c) => [c.id, c.postId]));
    const postIds = new Set<string>();
    for (const r of rows) {
      const postId = r.postId ?? (r.commentId ? postOfComment.get(r.commentId) : undefined);
      if (postId) postIds.add(postId);
    }
    const posts = postIds.size
      ? await this.prisma.modCommunityPost.findMany({
          where: { tenantId, id: { in: [...postIds] } },
          select: { id: true, tags: true },
        })
      : [];
    const tagsOf = new Map(posts.map((p) => [p.id, p.tags]));
    return rows.filter((r) => {
      const postId = r.postId ?? (r.commentId ? postOfComment.get(r.commentId) : undefined);
      // Sin post localizable no hay nada que enseñar ni que esconder: se deja.
      if (!postId) return true;
      const tags = tagsOf.get(postId);
      if (!tags) return true;
      return !SpaceAccess.isBlocked(tags, blocked);
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
     * Etiquetas del post donde va la mención. Quien no puede ver ese espacio
     * (nivel que no tiene) no recibe aviso; la fila sí se guarda y se filtra al
     * leer, por si gana el nivel más adelante.
     */
    postTags: readonly string[],
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

    const audience = await this.access.audienceForTags(
      tenantId,
      postTags,
      rowsToCreate.map((m) => m.mentionedUserId),
    );

    // Notifica vía NotificationHub al mencionado (in-app + email si está configurado).
    for (const m of rowsToCreate) {
      if (yaAvisados.has(m.mentionedUserId)) continue; // ya se le avisó de esta mención
      if (!audience.has(m.mentionedUserId)) continue; // no puede ver el espacio del post
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
    // Un aviso que nace de un post de un espacio con nivel solo va a quien
    // puede verlo: el total cuenta solo a esa gente.
    const postTags = input.postId ? await this.postTagsOf(tenantId, input.postId) : [];
    const total =
      postTags.length > 0 && (await this.isRestrictedByTags(tenantId, postTags))
        ? (
            await this.access.audienceForTags(
              tenantId,
              postTags,
              (
                await this.prisma.user.findMany({
                  where: { tenantId, ...WRITABLE_ACCOUNT },
                  select: { id: true },
                })
              ).map((u) => u.id),
            )
          ).size
        : await this.prisma.user.count({ where: { tenantId, ...WRITABLE_ACCOUNT } });
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
   * Toma el siguiente lote de destinatarios de un aviso (usuarios ACTIVE y no
   * eliminados con `id > cursor`, orden asc por id). Marca RUNNING en el primer
   * lote y DONE cuando ya no quedan. Devuelve cada destinatario con su flag de
   * baja para que el worker decida a quién enviar (los `important` ignoran la
   * baja). NO avanza el cursor — eso lo hace `commitBroadcastBatch` tras enviar
   * (resumible).
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
        ...WRITABLE_ACCOUNT,
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
        ...COMMUNITY_EMAIL_OPT_OUT,
      },
      select: { userId: true },
    });
    const optedSet = new Set(optedOut.map((o) => o.userId));
    // Si el aviso es de un post de un espacio con nivel, quien no lo tiene no
    // lo recibe: el extracto del post viaja en el correo.
    const postTags = b.postId ? await this.postTagsOf(b.tenantId, b.postId) : [];
    const audience =
      postTags.length > 0
        ? await this.access.audienceForTags(
            b.tenantId,
            postTags,
            users.map((u) => u.id),
          )
        : null;
    const recipients: BroadcastRecipient[] = users.map((u) => ({
      userId: u.id,
      email: u.email,
      optedOut: optedSet.has(u.id),
      canSee: audience ? audience.has(u.id) : true,
    }));
    return { broadcast: b, recipients, done: false };
  }

  /** Etiquetas de un post (aunque esté borrado: el aviso ya habla de él). */
  private async postTagsOf(tenantId: string, postId: string): Promise<string[]> {
    const post = await this.prisma.modCommunityPost.findFirst({
      where: { id: postId, tenantId },
      select: { tags: true },
    });
    return post?.tags ?? [];
  }

  /** ¿Alguna de estas etiquetas es un espacio con nivel? */
  private async isRestrictedByTags(tenantId: string, tags: readonly string[]): Promise<boolean> {
    const set = new Set(tags);
    return (await this.access.restrictedSpaces(tenantId)).some((s) => set.has(s.slug));
  }

  /**
   * De `userIds`, quiénes pueden ver el espacio `spaceId` (el equipo siempre).
   * Lo usa la sala de chat del espacio (mod.messaging) para no empujar
   * mensajes a quien ya no tiene el nivel.
   */
  async filterSpaceAudience(
    tenantId: string,
    spaceId: string,
    userIds: readonly string[],
  ): Promise<string[]> {
    const allowed = await this.access.audienceForSpace(tenantId, spaceId, userIds);
    return userIds.filter((u) => allowed.has(u));
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

  /**
   * Marca (o quita) la baja de los correos de la comunidad: avisos Y resumen
   * semanal. Es lo que hace el enlace «darse de baja» de cualquiera de los dos.
   *
   * Antes (`setBroadcastOptOut`) solo marcaba los avisos, y el resumen —que
   * miraba la otra marca— seguía saliendo cada semana a quien ya había pulsado
   * «darse de baja».
   */
  async setCommunityEmailOptOut(tenantId: string, userId: string, value: boolean) {
    await this.prisma.modCommunityUserPref.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, broadcastOptOut: value, digestOptOut: value },
      update: { broadcastOptOut: value, digestOptOut: value },
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
        idempotencyKey: eventIdempotencyKey(name, data),
      },
    });
  }

  // ── Espacios de comunidad ──────────────────────────────────────────────────

  /**
   * Lista los espacios del tenant ordenados por sortOrder, tal como los ve
   * quien pregunta: los que tienen un nivel que no tiene salen CERRADOS (nombre,
   * icono y niveles con los que se abren; sin descripción). Sin `viewer` se
   * listan como para un miembro sin niveles.
   */
  async listSpaces(
    tenantId: string,
    viewer: CommunityViewer = { canModerate: false },
  ): Promise<CommunitySpaceView[]> {
    const rows = await this.prisma.modCommunitySpace.findMany({
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
        accessGroupIds: true,
      },
    });
    const sv = spaceViewerOf(viewer);
    const restricted = rows.filter((r) => (r.accessGroupIds ?? []).length > 0);
    const mine =
      restricted.length > 0 && !sv.seesEverything
        ? new Set(await this.access.viewerGroups(tenantId, sv))
        : new Set<string>();
    const levels =
      restricted.length > 0
        ? await this.access.levels(
            tenantId,
            restricted.flatMap((r) => r.accessGroupIds ?? []),
          )
        : [];
    const levelById = new Map(levels.map((l) => [l.id, l]));
    return rows.map((r) => {
      const groupIds = r.accessGroupIds ?? [];
      const locked =
        groupIds.length > 0 && !sv.seesEverything && !groupIds.some((g) => mine.has(g));
      return {
        id: r.id,
        slug: r.slug,
        title: r.title,
        description: locked ? null : r.description,
        icon: r.icon,
        color: r.color,
        sortOrder: r.sortOrder,
        isSystem: r.isSystem,
        locked,
        accessLevels: groupIds
          .map((g) => levelById.get(g))
          .filter((l): l is AccessLevel => Boolean(l)),
        accessGroupIds: sv.seesEverything ? groupIds : [],
      };
    });
  }

  /** Niveles elegidos para un espacio: existentes y vivos en el aula, sin repetir. */
  private async validAccessGroupIds(tenantId: string, ids: readonly string[]): Promise<string[]> {
    const check = await this.access.checkGroups(tenantId, ids);
    if (!check.ok) throw new AccessGroupUnknownError(check.missing);
    return check.ids;
  }

  /** Crea un espacio. Rechaza slug duplicado en el tenant. */
  async createSpace(tenantId: string, createdById: string, dto: CreateSpaceDto) {
    const existing = await this.prisma.modCommunitySpace.findUnique({
      where: { tenantId_slug: { tenantId, slug: dto.slug } },
    });
    if (existing) throw new SpaceAlreadyExistsError(dto.slug);
    const accessGroupIds = await this.validAccessGroupIds(tenantId, dto.accessGroupIds ?? []);
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
        accessGroupIds,
      },
    });
  }

  /** Edita un espacio existente (parcial). */
  async updateSpace(tenantId: string, slug: string, dto: UpdateSpaceDto) {
    const space = await this.prisma.modCommunitySpace.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
    });
    if (!space) throw new SpaceNotFoundError(slug);
    const accessGroupIds =
      dto.accessGroupIds !== undefined
        ? await this.validAccessGroupIds(tenantId, dto.accessGroupIds)
        : undefined;
    return this.prisma.modCommunitySpace.update({
      where: { tenantId_slug: { tenantId, slug } },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(accessGroupIds !== undefined && { accessGroupIds }),
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
 * Quita del body los comentarios HTML, incluido el marcador de adjuntos que
 * serializa el compositor (`<!--didacta-attachments:{…}-->`): en un extracto
 * saldría el JSON de las imágenes en vez del texto.
 */
export function stripAttachmentMarker(body: string): string {
  return body.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
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
