/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';

/**
 * Cliente de /admin/imagenes: inventario y reoptimización del histórico de
 * imágenes del tenant. Lo que se sube nuevo ya nace optimizado en el backend,
 * así que esto solo sirve para lo que entró antes.
 */

export type ImageSource = 'avatar' | 'curso' | 'coleccion' | 'logo' | 'post';

export type SkipReason = 'externa' | 'no-encontrada' | 'no-raster' | 'ya-optima' | null;

export interface ImageRef {
  source: ImageSource;
  ownerId: string;
  label: string;
  url: string;
}

export interface AnalyzedImage extends ImageRef {
  currentSize: number | null;
  optimizedSize: number | null;
  skipReason: SkipReason;
}

export interface ImagesInventory {
  items: AnalyzedImage[];
  currentBytes: number;
  optimizedBytes: number;
  optimizable: number;
  /** true si había más imágenes de las que el backend analiza por pasada. */
  truncated: boolean;
}

export interface OptimizeOutcome {
  source: ImageSource;
  ownerId: string;
  ok: boolean;
  previousSize?: number;
  size?: number;
  error?: string;
}

export const adminImagesApi = {
  inventory(bearer: string): Promise<ImagesInventory> {
    return apiFetch<ImagesInventory>('/api/v1/admin/images/inventory', {}, bearer);
  },

  optimize(bearer: string, refs: ImageRef[]): Promise<{ results: OptimizeOutcome[] }> {
    return apiFetch<{ results: OptimizeOutcome[] }>(
      '/api/v1/admin/images/optimize',
      { method: 'POST', body: JSON.stringify({ refs }) },
      bearer,
    );
  },
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
