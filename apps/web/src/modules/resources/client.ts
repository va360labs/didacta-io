/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/** Cliente HTTP de mod.resources (bloque 4 — biblioteca por colecciones). */

const BASE = '/api/v1/modules/resources';

export type ResourceKind = 'FILE' | 'LINK';

export interface CollectionView {
  id: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  isDefault: boolean;
  resourceCount: number;
}

export interface ResourceView {
  id: string;
  collectionId: string;
  kind: ResourceKind;
  title: string;
  description: string | null;
  url: string;
  fileName: string | null;
  createdById: string;
  downloadCount: number;
  createdAt: string;
}

export interface CreateResourceInput {
  collectionId: string;
  kind: ResourceKind;
  title: string;
  description?: string;
  url: string;
  fileName?: string;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

export const resourcesApi = {
  async listCollections(): Promise<CollectionView[]> {
    const res = await apiFetch<{ collections: CollectionView[] }>(
      `${BASE}/collections`,
      { method: 'GET' },
      withAuth(),
    );
    return res.collections;
  },

  async getCollection(
    id: string,
    q?: string,
  ): Promise<{ collection: CollectionView; resources: ResourceView[] }> {
    const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    return apiFetch(`${BASE}/collections/${id}${qs}`, { method: 'GET' }, withAuth());
  },

  async createCollection(input: {
    title: string;
    description?: string;
    coverUrl?: string;
  }): Promise<CollectionView> {
    return apiFetch<CollectionView>(
      `${BASE}/collections`,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async updateCollection(
    id: string,
    patch: { title?: string; description?: string | null; coverUrl?: string | null },
  ): Promise<CollectionView> {
    return apiFetch<CollectionView>(
      `${BASE}/collections/${id}`,
      { method: 'PUT', body: JSON.stringify(patch) },
      withAuth(),
    );
  },

  async deleteCollection(id: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`${BASE}/collections/${id}`, { method: 'DELETE' }, withAuth());
  },

  /** Cualquier miembro comparte un recurso en una colección. */
  async create(input: CreateResourceInput): Promise<ResourceView> {
    return apiFetch<ResourceView>(
      BASE,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  /** Registra la descarga/apertura y devuelve la URL a abrir. */
  async download(id: string): Promise<{ url: string }> {
    return apiFetch<{ url: string }>(`${BASE}/${id}/download`, { method: 'POST' }, withAuth());
  },

  async remove(id: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`${BASE}/${id}`, { method: 'DELETE' }, withAuth());
  },
};
