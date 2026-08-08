/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

export interface Post {
  id: string;
  tenantId: string;
  authorId: string;
  authorDisplayName: string | null;
  courseId: string | null;
  title: string;
  body: string;
  tags: string[];
  /** Origen de la publicación: 'web' (UI) o 'api' (POST /community-api/posts). */
  source: 'web' | 'api';
  createdAt: string;
  updatedAt: string;
  /** Última edición de contenido (title/body/tags). null = nunca editado. */
  editedAt: string | null;
  deletedAt: string | null;
  /** Set por moderador. Solo aparece en respuestas si el viewer es admin. */
  hiddenAt: string | null;
  hiddenById: string | null;
  hiddenReason: string | null;
  /**
   * Si está set, el post está fijado por un admin y va al tope del feed.
   * `pinnedById` es el UUID del moderador que lo fijó (sin FK a IAM).
   */
  pinnedAt: string | null;
  pinnedById: string | null;
  /**
   * Conteo de comentarios visibles del post (los ocultos solo cuentan
   * para admins). Lo agrega el listado vía Prisma `_count`. En endpoints
   * que no incluyen `_count` (como getPost, que ya trae los comentarios),
   * puede venir undefined.
   */
  _count?: {
    comments: number;
  };
  /**
   * Reacciones del post (no de los comentarios). El listado las incluye
   * para que la UI agregue por emoji y sepa cuáles son del viewer.
   * `getPost` también las devuelve por compatibilidad con el detalle.
   */
  reactions?: Reaction[];
}

export interface Comment {
  id: string;
  tenantId: string;
  postId: string;
  authorId: string;
  authorDisplayName: string | null;
  body: string;
  /** UUID del comentario padre si esto es una respuesta. */
  parentCommentId: string | null;
  createdAt: string;
  deletedAt: string | null;
  hiddenAt: string | null;
  hiddenById: string | null;
  hiddenReason: string | null;
}

export interface Reaction {
  id: string;
  tenantId: string;
  postId: string | null;
  commentId: string | null;
  authorId: string;
  emoji: string;
  createdAt: string;
}

export interface PostDetail extends Post {
  comments: Comment[];
  reactions: Reaction[];
}

/** Aviso masivo a la comunidad y su progreso de envío. */
export interface Broadcast {
  id: string;
  subject: string;
  bodyText: string;
  postId: string | null;
  important: boolean;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

export type PostSort = 'recent' | 'oldest' | 'most_commented';

/** Adjunto aplanado que devuelve la Galería (ver backend mod-community). */
export interface CommunityAttachment {
  kind: 'image' | 'file';
  url: string;
  name: string;
  size?: number;
  postId: string;
  postTitle: string;
  authorId: string;
  authorName: string | null;
  /** ISO-8601 (createdAt del post). */
  createdAt: string;
}

export const communityApi = {
  async listPosts(
    opts: {
      courseId?: string;
      tag?: string;
      sort?: PostSort;
      limit?: number;
      authorId?: string;
      /** Filtra por origen: 'api' = publicado vía POST /community-api/posts. */
      source?: 'web' | 'api';
    } = {},
  ): Promise<Post[]> {
    const params = new URLSearchParams();
    if (opts.courseId) params.set('courseId', opts.courseId);
    if (opts.tag) params.set('tag', opts.tag);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.authorId) params.set('authorId', opts.authorId);
    if (opts.source) params.set('source', opts.source);
    const path = `/api/v1/modules/community/posts${params.toString() ? `?${params}` : ''}`;
    return apiFetch<Post[]>(path, { method: 'GET' }, withAuth());
  },
  async listAttachments(opts: { tag?: string } = {}): Promise<CommunityAttachment[]> {
    const params = new URLSearchParams();
    if (opts.tag) params.set('tag', opts.tag);
    const path = `/api/v1/modules/community/attachments${params.toString() ? `?${params}` : ''}`;
    return apiFetch<CommunityAttachment[]>(path, { method: 'GET' }, withAuth());
  },
  async getPost(id: string): Promise<PostDetail> {
    return apiFetch<PostDetail>(
      `/api/v1/modules/community/posts/${id}`,
      { method: 'GET' },
      withAuth(),
    );
  },
  async createPost(input: {
    title: string;
    body: string;
    tags?: string[];
    courseId?: string;
    /** Solo admins: avisar por email + campana a todos los miembros. */
    notifyAll?: boolean;
    /** Marca el aviso como importante (ignora la baja del receptor). */
    important?: boolean;
  }): Promise<Post> {
    return apiFetch<Post>(
      '/api/v1/modules/community/posts',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },
  async updatePost(
    id: string,
    input: { title?: string; body?: string; tags?: string[] },
  ): Promise<Post> {
    return apiFetch<Post>(
      `/api/v1/modules/community/posts/${id}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      withAuth(),
    );
  },
  async deletePost(id: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/modules/community/posts/${id}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
  async addComment(postId: string, body: string, parentCommentId?: string): Promise<Comment> {
    return apiFetch<Comment>(
      `/api/v1/modules/community/posts/${postId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          body,
          ...(parentCommentId ? { parentCommentId } : {}),
        }),
      },
      withAuth(),
    );
  },
  async deleteComment(id: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/modules/community/comments/${id}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
  async moderatePost(postId: string, hidden: boolean, reason?: string): Promise<Post> {
    return apiFetch<Post>(
      `/api/v1/modules/community/posts/${postId}/moderate`,
      {
        method: 'POST',
        body: JSON.stringify({ hidden, ...(reason ? { reason } : {}) }),
      },
      withAuth(),
    );
  },
  async pinPost(postId: string): Promise<Post> {
    return apiFetch<Post>(
      `/api/v1/modules/community/posts/${postId}/pin`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
  async unpinPost(postId: string): Promise<Post> {
    return apiFetch<Post>(
      `/api/v1/modules/community/posts/${postId}/unpin`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
  async searchUsers(
    prefix: string,
  ): Promise<Array<{ userId: string; handle: string; displayName: string | null }>> {
    const params = new URLSearchParams({ prefix });
    return apiFetch(
      `/api/v1/modules/community/users/search?${params.toString()}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async listMyMentions(): Promise<
    Array<{
      id: string;
      postId: string | null;
      commentId: string | null;
      mentionedHandle: string;
      authorId: string;
      createdAt: string;
    }>
  > {
    return apiFetch('/api/v1/modules/community/mentions/me', { method: 'GET' }, withAuth());
  },

  async moderateComment(commentId: string, hidden: boolean, reason?: string): Promise<Comment> {
    return apiFetch<Comment>(
      `/api/v1/modules/community/comments/${commentId}/moderate`,
      {
        method: 'POST',
        body: JSON.stringify({ hidden, ...(reason ? { reason } : {}) }),
      },
      withAuth(),
    );
  },
  async addReactionToPost(postId: string, emoji: string): Promise<Reaction> {
    return apiFetch<Reaction>(
      '/api/v1/modules/community/reactions',
      { method: 'POST', body: JSON.stringify({ postId, emoji }) },
      withAuth(),
    );
  },
  async addReactionToComment(commentId: string, emoji: string): Promise<Reaction> {
    return apiFetch<Reaction>(
      '/api/v1/modules/community/reactions',
      { method: 'POST', body: JSON.stringify({ commentId, emoji }) },
      withAuth(),
    );
  },
  async removeReaction(id: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/modules/community/reactions/${id}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },

  async getMyPreferences(): Promise<{ digestOptOut: boolean }> {
    return apiFetch<{ digestOptOut: boolean }>(
      '/api/v1/modules/community/me/preferences',
      { method: 'GET' },
      withAuth(),
    );
  },

  async updateMyPreferences(patch: { digestOptOut?: boolean }): Promise<{ digestOptOut: boolean }> {
    return apiFetch<{ digestOptOut: boolean }>(
      '/api/v1/modules/community/me/preferences',
      { method: 'PUT', body: JSON.stringify(patch) },
      withAuth(),
    );
  },

  // ── Avisos masivos (broadcast) — solo admins ──────────────────────────────
  async createBroadcast(input: {
    subject: string;
    bodyText: string;
    important?: boolean;
  }): Promise<Broadcast> {
    return apiFetch<Broadcast>(
      '/api/v1/modules/community/broadcasts',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async listBroadcasts(): Promise<Broadcast[]> {
    return apiFetch<Broadcast[]>(
      '/api/v1/modules/community/broadcasts',
      { method: 'GET' },
      withAuth(),
    );
  },

  async listTags(): Promise<CommunityTag[]> {
    return apiFetch<CommunityTag[]>(
      '/api/v1/modules/community/tags',
      { method: 'GET' },
      withAuth(),
    );
  },

  async createTag(input: {
    name: string;
    color: string;
    icon?: string | null;
  }): Promise<CommunityTag> {
    return apiFetch<CommunityTag>(
      '/api/v1/modules/community/tags',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async updateTag(
    id: string,
    patch: { name?: string; color?: string; icon?: string | null },
  ): Promise<CommunityTag> {
    return apiFetch<CommunityTag>(
      `/api/v1/modules/community/tags/${id}`,
      { method: 'PUT', body: JSON.stringify(patch) },
      withAuth(),
    );
  },

  async deleteTag(id: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/modules/community/tags/${id}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },

  async listSpaces(): Promise<CommunitySpace[]> {
    return apiFetch<CommunitySpace[]>(
      '/api/v1/modules/community/spaces',
      { method: 'GET' },
      withAuth(),
    );
  },

  async createSpace(input: {
    slug: string;
    title: string;
    description?: string | null;
    icon?: string;
    color?: string;
    sortOrder?: number;
  }): Promise<CommunitySpace> {
    return apiFetch<CommunitySpace>(
      '/api/v1/modules/community/spaces',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async updateSpace(
    slug: string,
    patch: {
      title?: string;
      description?: string | null;
      icon?: string;
      color?: string;
      sortOrder?: number;
    },
  ): Promise<CommunitySpace> {
    return apiFetch<CommunitySpace>(
      `/api/v1/modules/community/spaces/${slug}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      withAuth(),
    );
  },

  async deleteSpace(slug: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/modules/community/spaces/${slug}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
};

export interface CommunityTag {
  id: string;
  tenantId: string;
  name: string;
  color: string;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommunitySpace {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  icon: string;
  color: string;
  sortOrder: number;
  isSystem: boolean;
}

/**
 * Set de iconos válidos para espacios — subconjunto de IconName que tiene
 * sentido semánticamente para canales de comunidad.
 */
export const COMMUNITY_SPACE_ICONS = [
  'hash',
  'megaphone',
  'help',
  'file',
  'globe',
  'message',
  'book',
  'shield',
  'sparkles',
  'award',
  'users',
  'video',
  'calendar',
] as const;
export type CommunitySpaceIcon = (typeof COMMUNITY_SPACE_ICONS)[number];

/**
 * Set de iconos válidos para tags. Debe coincidir con `COMMUNITY_TAG_ICONS`
 * del módulo. Lo duplicamos acá para que la UI pueda construir el selector
 * sin importar nada del backend.
 */
export const COMMUNITY_TAG_ICONS = [
  'message',
  'help',
  'sparkles',
  'book',
  'users',
  'award',
  'bell',
  'shield',
  'alert',
] as const;
export type CommunityTagIcon = (typeof COMMUNITY_TAG_ICONS)[number];
