/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface UploadResult {
  key: string;
  url: string;
  contentType: string;
  size: number;
}

export interface OptimizeImageOptions {
  /** Ancho máximo en px (nunca amplía). El backend acota a [64, 4096]. */
  maxWidth?: number;
  /** Calidad WebP. El backend acota a [40, 95]. */
  quality?: number;
}

export interface OptimizeResult {
  url: string;
  contentType: string | null;
  size: number;
  previousSize: number;
  /** true si la imagen se recomprimió a algo más ligero. */
  optimized: boolean;
  width?: number;
  height?: number;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

/**
 * Lee un File como base64 puro (sin el prefijo `data:...,`).
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('No se pudo leer el archivo.'));
        return;
      }
      // result es `data:<mime>;base64,<XXX>` — quitamos el prefijo.
      const idx = result.indexOf(',');
      resolve(idx === -1 ? result : result.slice(idx + 1));
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

export const storageApi = {
  /**
   * Sube una imagen al storage del tenant y devuelve la URL para
   * incrustar en `<img src>`. El backend auto-optimiza las imágenes raster
   * (recomprime a WebP y redimensiona); `opts.optimize` afina el ancho/calidad
   * o `optimize: false` la desactiva para esa subida.
   */
  async uploadImage(
    file: File,
    opts?: { optimize?: OptimizeImageOptions | false },
  ): Promise<UploadResult> {
    const data = await fileToBase64(file);
    const optimize =
      opts?.optimize === false
        ? { enabled: false }
        : opts?.optimize
          ? { enabled: true, ...opts.optimize }
          : undefined; // sin override: el backend optimiza con sus defaults
    return apiFetch<UploadResult>(
      '/api/v1/storage/upload',
      {
        method: 'POST',
        body: JSON.stringify({
          data,
          filename: file.name,
          contentType: file.type,
          ...(optimize ? { optimize } : {}),
        }),
      },
      withAuth(),
    );
  },

  /**
   * Reoptimiza una imagen YA subida (identificada por su URL de storage) y
   * devuelve la nueva URL. Para arreglar imágenes pesadas subidas antes de que
   * existiera la auto-optimización. Si ya estaba óptima, devuelve la URL
   * original con `optimized: false`.
   */
  async optimizeExisting(url: string, opts?: OptimizeImageOptions): Promise<OptimizeResult> {
    return apiFetch<OptimizeResult>(
      '/api/v1/storage/optimize',
      {
        method: 'POST',
        body: JSON.stringify({ url, ...(opts ?? {}) }),
      },
      withAuth(),
    );
  },
};
