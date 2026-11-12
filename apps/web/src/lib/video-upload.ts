/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import { formatNumber } from './i18n/format';

/**
 * Subida de vídeo de la lección directamente del navegador a Bunny Stream
 * (Didacta Cloud).
 *
 * La API comprueba los límites y firma la subida; los bytes van del navegador
 * a Bunny por TUS (reanudable), sin pasar por nuestro servidor. Si la
 * instalación no tiene la subida encendida, `quota()` da 404 y el editor
 * ofrece solo el enlace, como siempre.
 */

export interface VideoQuota {
  tier: 'pre_sale' | 'post_sale';
  maxResolution: '720p' | '1080p';
  stored: { usedSeconds: number; limitSeconds: number; bonusSeconds: number };
  watched: { month: string; usedSeconds: number; limitSeconds: number | null };
  maxFileBytes: number;
  maxFileSeconds: number;
  postSaleStoredSeconds: number;
}

export type VideoAssetStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'DELETED';

export interface VideoAsset {
  id: string;
  lessonId: string | null;
  title: string;
  status: VideoAssetStatus;
  failureReason: string | null;
  durationSeconds: number | null;
  maxResolution: string;
  embedUrl: string;
  thumbnailUrl: string | null;
  createdAt: string;
}

export interface TusTicket {
  endpoint: string;
  headers: {
    AuthorizationSignature: string;
    AuthorizationExpire: string;
    VideoId: string;
    LibraryId: string;
  };
  metadata: { filetype: string; title: string; collection: string };
  expiresAt: string;
}

function requireToken(): string {
  const token = authStorage.getAccessToken();
  if (!token) {
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  }
  return token;
}

const BASE = '/api/v1/video/uploads';

export const videoUploadApi = {
  /** null si la instalación no tiene la subida de vídeo (404) o no puedes usarla (403). */
  async quota(): Promise<VideoQuota | null> {
    try {
      return await apiFetch<VideoQuota>(`${BASE}/quota`, {}, requireToken());
    } catch (e) {
      if (e instanceof ApiHttpError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  },
  create(input: {
    lessonId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number;
  }): Promise<{ asset: VideoAsset; upload: TusTicket }> {
    return apiFetch(BASE, { method: 'POST', body: JSON.stringify(input) }, requireToken());
  },
  get(id: string): Promise<VideoAsset> {
    return apiFetch(`${BASE}/${encodeURIComponent(id)}`, {}, requireToken());
  },
  listForLesson(lessonId: string): Promise<VideoAsset[]> {
    return apiFetch(`${BASE}?lessonId=${encodeURIComponent(lessonId)}`, {}, requireToken());
  },
  resign(id: string): Promise<TusTicket> {
    return apiFetch(
      `${BASE}/${encodeURIComponent(id)}/signature`,
      { method: 'POST' },
      requireToken(),
    );
  },
  remove(id: string): Promise<void> {
    return apiFetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }, requireToken());
  },
};

/** «4 h 20 min», «5 h», «45 min», «0 min». Redondea hacia abajo al minuto. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * Como `formatDuration`, pero redondeando HACIA ARRIBA al minuto: para lo que
 * se ha gastado o lo que dura un vídeo. Truncar decía «Has usado 0 min» con un
 * vídeo de 32 s subido, y «dura 2 h y el máximo es 2 h» con uno de 2 h 0 min
 * 30 s. Los límites y el espacio libre siguen truncando (no prometen de más).
 */
export function formatUsedDuration(seconds: number): string {
  return formatDuration(Math.ceil(Math.max(0, seconds) / 60) * 60);
}

/** «1,2 GB», «850 MB» (en la unidad del explorador de archivos). */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${formatNumber(gb, { maximumFractionDigits: 1 })} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Porcentaje 0–100 para la barra (sin pasarse de 100). */
export function usedPercent(used: number, limit: number | null): number {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export type PreflightProblem =
  | { kind: 'not_video' }
  | { kind: 'too_big'; limitBytes: number }
  | { kind: 'too_long'; limitSeconds: number }
  | { kind: 'no_room'; quota: VideoQuota };

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|flv|3gp|ts|mts)$/i;

export function looksLikeVideo(file: { type: string; name: string }): boolean {
  if (/^video\//i.test(file.type)) return true;
  if (file.type && file.type !== 'application/octet-stream') return false;
  return VIDEO_EXT.test(file.name);
}

/**
 * Lo mismo que comprobará el servidor, antes de pedir la firma: así el
 * creador lo sabe al soltar el fichero y no al cabo de un rato.
 */
export function preflight(
  file: { type: string; name: string; size: number },
  durationSeconds: number,
  quota: VideoQuota,
): PreflightProblem | null {
  if (!looksLikeVideo(file)) return { kind: 'not_video' };
  if (file.size > quota.maxFileBytes) return { kind: 'too_big', limitBytes: quota.maxFileBytes };
  if (durationSeconds > quota.maxFileSeconds) {
    return { kind: 'too_long', limitSeconds: quota.maxFileSeconds };
  }
  if (quota.stored.usedSeconds + durationSeconds > quota.stored.limitSeconds) {
    return { kind: 'no_room', quota };
  }
  return null;
}

/**
 * Duración del fichero leída por el propio navegador (sin subirlo). null si
 * no la puede leer (algunos formatos que el navegador no reproduce).
 */
export function readVideoDuration(file: File, timeoutMs = 15_000): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(value);
    };
    const timer = window.setTimeout(() => done(null), timeoutMs);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      const d = video.duration;
      done(Number.isFinite(d) && d > 0 ? d : null);
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      done(null);
    };
    video.src = url;
  });
}

export interface UploadHandle {
  pause(): void;
  resume(): void;
  abort(): Promise<void>;
}

/**
 * Sube el fichero a Bunny por TUS con la firma que dio la API. Si la firma
 * caduca (24 h) entre pausa y reanudación, pide otra antes de seguir.
 */
export async function startTusUpload(input: {
  file: File;
  assetId: string;
  ticket: TusTicket;
  onProgress: (sent: number, total: number) => void;
  onSuccess: () => void;
  onError: (error: Error) => void;
  /** Para los tests. */
  resign?: (id: string) => Promise<TusTicket>;
}): Promise<UploadHandle> {
  const { Upload } = await import('tus-js-client');
  let ticket = input.ticket;
  const upload = new Upload(input.file, {
    endpoint: ticket.endpoint,
    headers: { ...ticket.headers },
    metadata: {
      filetype: input.file.type || ticket.metadata.filetype,
      title: ticket.metadata.title,
      ...(ticket.metadata.collection ? { collection: ticket.metadata.collection } : {}),
    },
    // Reintentos ante cortes de red: 0 s, 3 s, 5 s, 10 s, 20 s, 1 min.
    retryDelays: [0, 3000, 5000, 10000, 20000, 60000],
    // Cada subida es un vídeo nuevo en Bunny: no se reanuda entre recargas.
    storeFingerprintForResuming: false,
    onProgress: (sent, total) => input.onProgress(sent, total),
    onSuccess: () => input.onSuccess(),
    onError: (error) => input.onError(error),
  });
  upload.start();

  const resign = input.resign ?? videoUploadApi.resign;
  return {
    pause() {
      void upload.abort(false);
    },
    resume() {
      void (async () => {
        if (Date.parse(ticket.expiresAt) - Date.now() < 10 * 60_000) {
          ticket = await resign(input.assetId);
          upload.options.headers = { ...ticket.headers };
        }
        upload.start();
      })().catch((err: unknown) => input.onError(err as Error));
    },
    async abort() {
      await upload.abort(false).catch(() => undefined);
    },
  };
}
