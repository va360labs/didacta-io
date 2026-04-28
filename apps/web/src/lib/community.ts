import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface Post {
  id: string;
  tenantId: string;
  authorId: string;
  authorDisplayName: string | null;
  courseId: string | null;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Set por moderador. Solo aparece en respuestas si el viewer es admin. */
  hiddenAt: string | null;
  hiddenById: string | null;
  hiddenReason: string | null;
  /**
   * Conteo de comentarios visibles del post (los ocultos solo cuentan
   * para admins). Lo agrega el listado vía Prisma `_count`. En endpoints
   * que no incluyen `_count` (como getPost, que ya trae los comentarios),
   * puede venir undefined.
   */
  _count?: {
    comments: number;
  };
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

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export type PostSort = 'recent' | 'oldest' | 'most_commented';

export const communityApi = {
  async listPosts(
    opts: { courseId?: string; tag?: string; sort?: PostSort; limit?: number } = {},
  ): Promise<Post[]> {
    const params = new URLSearchParams();
    if (opts.courseId) params.set('courseId', opts.courseId);
    if (opts.tag) params.set('tag', opts.tag);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.limit) params.set('limit', String(opts.limit));
    const path = `/api/v1/modules/community/posts${params.toString() ? `?${params}` : ''}`;
    return apiFetch<Post[]>(path, { method: 'GET' }, withAuth());
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
  }): Promise<Post> {
    return apiFetch<Post>(
      '/api/v1/modules/community/posts',
      { method: 'POST', body: JSON.stringify(input) },
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
};
