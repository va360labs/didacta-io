/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { CommunityAttachment } from './client';

export type GalleryType = 'all' | 'image' | 'file';
export type GallerySort = 'recent' | 'oldest';

export interface GalleryFilters {
  type: GalleryType;
  sort: GallerySort;
  /** Id de autor o 'all'. */
  authorId: string;
  /** Búsqueda por nombre (case-insensitive). */
  search: string;
  /** Rango de fechas en formato yyyy-mm-dd (inclusive). */
  from?: string;
  to?: string;
}

export const DEFAULT_GALLERY_FILTERS: GalleryFilters = {
  type: 'all',
  sort: 'recent',
  authorId: 'all',
  search: '',
};

/**
 * Lista única de autores presentes en el conjunto de adjuntos, para poblar el
 * selector de "Autor". Ordenada por nombre (los sin nombre al final).
 */
export function galleryAuthorOptions(
  items: CommunityAttachment[],
): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>();
  for (const a of items) {
    if (!byId.has(a.authorId)) byId.set(a.authorId, a.authorName ?? 'Sin nombre');
  }
  return Array.from(byId, ([id, name]) => ({ id, name })).sort((x, y) =>
    x.name.localeCompare(y.name, 'es'),
  );
}

/** Aplica todos los filtros + orden sobre el conjunto de adjuntos. */
export function filterGalleryAttachments(
  items: CommunityAttachment[],
  filters: GalleryFilters,
): CommunityAttachment[] {
  const search = filters.search.trim().toLowerCase();
  const result = items.filter((a) => {
    if (filters.type !== 'all' && a.kind !== filters.type) return false;
    if (filters.authorId !== 'all' && a.authorId !== filters.authorId) return false;
    if (search && !a.name.toLowerCase().includes(search)) return false;
    // createdAt es ISO en UTC; comparamos solo la parte de fecha (yyyy-mm-dd)
    // lexicográficamente, que es TZ-agnóstico y suficiente para el rango.
    const day = a.createdAt.slice(0, 10);
    if (filters.from && day < filters.from) return false;
    if (filters.to && day > filters.to) return false;
    return true;
  });
  result.sort((x, y) =>
    filters.sort === 'oldest'
      ? x.createdAt.localeCompare(y.createdAt)
      : y.createdAt.localeCompare(x.createdAt),
  );
  return result;
}
