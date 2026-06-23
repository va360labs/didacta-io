'use client';

import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface CommunityPost {
  id: string;
  title: string;
  body: string;
  authorId: string;
  authorName: string | null;
  tags: string[];
  createdAt: string;
  commentCount: number;
  reactionCount: number;
  reactions: Array<{ emoji: string; count: number; byMe: boolean }>;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new Error('No autenticado');
  return token;
}

export const communityPostsApi = {
  async create(data: { title: string; body: string; tags?: string[] }): Promise<CommunityPost> {
    return apiFetch(
      '/api/v1/modules/community/posts',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
      withAuth(),
    );
  },

  async list(
    query: { tag?: string; limit?: number; sort?: string } = {},
  ): Promise<CommunityPost[]> {
    const usp = new URLSearchParams();
    if (query.tag) usp.set('tag', query.tag);
    if (query.limit) usp.set('limit', String(query.limit));
    if (query.sort) usp.set('sort', query.sort);
    const qs = usp.toString();
    return apiFetch<CommunityPost[]>(
      `/api/v1/modules/community/posts${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async delete(postId: string): Promise<void> {
    await apiFetch(`/api/v1/modules/community/posts/${postId}`, { method: 'DELETE' }, withAuth());
  },
};
