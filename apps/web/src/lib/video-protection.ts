/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import {
  bunnyBaseEmbedUrl,
  bunnyRefKey,
  isPlayUrlFresh,
  type BunnyPlayUrlEntry,
  type BunnyRef,
} from './video';

/**
 * Cliente de la protección de vídeo de Bunny Stream.
 *
 * Las URL de embed que guardan las lecciones son permanentes. Si la academia
 * protege sus vídeos (clave de firma guardada en Administración → Seguridad y
 * autenticación por token activa en Bunny), esas URL ya no cargan por sí
 * solas: el reproductor pide a la API una URL FIRMADA (`token` + `expires`)
 * para el vídeo concreto. La API comprueba que el alumno tiene derecho a ese
 * vídeo y aplica un tope de vídeos distintos por hora/día por cuenta.
 *
 * Si la academia NO los protege, la API devuelve la misma URL de siempre y el
 * reproductor se comporta como antes.
 */

export interface PlayUrlResponse {
  /** URL de embed lista para el iframe (firmada si la librería está protegida). */
  url: string;
  /** Caducidad de la firma (ISO), o null si la URL no va firmada. */
  expiresAt: string | null;
  /** La librería de este vídeo está protegida en esta academia. */
  protected: boolean;
  /** Hay que pintar la marca de agua con la identidad del alumno. */
  watermark: boolean;
}

export type PlayUrlErrorKind = 'forbidden' | 'rate_limited' | 'watch_quota' | 'unknown';

export class PlayUrlError extends Error {
  constructor(readonly kind: PlayUrlErrorKind) {
    super(kind);
    this.name = 'PlayUrlError';
  }
}

/**
 * Traduce el error HTTP de la play-url a lo que el reproductor necesita
 * mostrar. Se decide por el `code` estable de la API y NO por el status: un
 * 429 puede ser el límite de peticiones de la academia entera (no el tope de
 * vídeos de esta cuenta) y un 403 puede venir de otra capa.
 */
export function toPlayUrlError(error: unknown): PlayUrlError {
  if (error instanceof PlayUrlError) return error;
  if (error instanceof ApiHttpError) {
    if (error.code === 'VIDEO_FORBIDDEN') return new PlayUrlError('forbidden');
    if (error.code === 'VIDEO_RATE_LIMITED') return new PlayUrlError('rate_limited');
    // Vídeo subido a la academia: se ha llegado al tope de horas vistas del mes.
    if (error.code === 'VIDEO_WATCH_QUOTA') return new PlayUrlError('watch_quota');
  }
  return new PlayUrlError('unknown');
}

// ─────────────────────────── panel de administración ───────────────────────────

export type SignatureCheckOutcome =
  | 'ok'
  | 'not_enforced'
  | 'rejected'
  | 'video_unavailable'
  | 'unreachable'
  | 'no_key'
  | 'no_video';

export interface VideoProtectionLibrary {
  libraryId: string;
  /** Tiene clave de firma guardada. */
  configured: boolean;
  /** Aparece en algún vídeo de los cursos de la academia. */
  inUse: boolean;
  lastCheck: { outcome: SignatureCheckOutcome; checkedAt: string } | null;
}

export interface VideoProtectionState {
  /** Interruptor de la academia. */
  enabled: boolean;
  /** `enabled` y al menos una librería con clave: hay URLs saliendo firmadas. */
  active: boolean;
  watermark: boolean;
  limits: { perHour: number; perDay: number };
  libraries: VideoProtectionLibrary[];
}

export interface VideoProtectionSettingsPatch {
  enabled?: boolean;
  watermark?: boolean;
  maxVideosPerHour?: number;
  maxVideosPerDay?: number;
}

export interface VideoSignatureCheck {
  libraryId: string;
  outcome: SignatureCheckOutcome;
  checkedAt: string;
  signedStatus: number | null;
  unsignedStatus: number | null;
}

/** Estado que resume la tarjeta del panel. */
export type VideoProtectionSummary = 'off' | 'disabled' | 'unverified' | 'attention' | 'on';

/**
 * - `off`: nunca se ha guardado una clave. Los vídeos se reproducen como siempre.
 * - `disabled`: hay clave, pero el admin ha apagado la protección.
 * - `attention`: activa, y la última comprobación de alguna librería dice que
 *   Bunny no acepta la firma o que aún no exige token (los vídeos siguen abiertos).
 * - `unverified`: activa, pero alguna librería con clave está sin comprobar.
 * - `on`: activa y todas las librerías con clave comprobadas contra Bunny.
 */
export function summarizeVideoProtection(state: VideoProtectionState): VideoProtectionSummary {
  const configured = state.libraries.filter((l) => l.configured);
  if (configured.length === 0) return 'off';
  if (!state.enabled) return 'disabled';
  if (configured.some((l) => l.lastCheck && l.lastCheck.outcome !== 'ok')) return 'attention';
  if (configured.some((l) => !l.lastCheck)) return 'unverified';
  return 'on';
}

function requireToken(): string {
  const token = authStorage.getAccessToken();
  if (!token) {
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  }
  return token;
}

const ADMIN_BASE = '/api/v1/admin/video-protection';

export const videoProtectionApi = {
  playUrl(ref: BunnyRef): Promise<PlayUrlResponse> {
    const path = `/api/v1/video/bunny/${encodeURIComponent(ref.libraryId)}/${encodeURIComponent(ref.guid)}/play-url`;
    return apiFetch<PlayUrlResponse>(path, {}, requireToken());
  },
  getAdmin(): Promise<VideoProtectionState> {
    return apiFetch<VideoProtectionState>(ADMIN_BASE, {}, requireToken());
  },
  saveSettings(patch: VideoProtectionSettingsPatch): Promise<VideoProtectionState> {
    return apiFetch<VideoProtectionState>(
      `${ADMIN_BASE}/settings`,
      { method: 'PUT', body: JSON.stringify(patch) },
      requireToken(),
    );
  },
  saveTokenKey(libraryId: string, tokenKey: string): Promise<VideoProtectionState> {
    return apiFetch<VideoProtectionState>(
      `${ADMIN_BASE}/token-key`,
      { method: 'PUT', body: JSON.stringify({ libraryId, tokenKey }) },
      requireToken(),
    );
  },
  check(libraryId: string): Promise<VideoSignatureCheck> {
    return apiFetch<VideoSignatureCheck>(
      `${ADMIN_BASE}/check`,
      { method: 'POST', body: JSON.stringify({ libraryId }) },
      requireToken(),
    );
  },
};

// ───────────────────── resolución de la URL de reproducción ─────────────────────

export interface PlayUrlResolverDeps {
  playUrl: (ref: BunnyRef) => Promise<PlayUrlResponse>;
  now: () => number;
}

/**
 * Pide (o reutiliza) la URL de reproducción de los vídeos de Bunny de la
 * página. Lógica sin React, para poder probarla.
 *
 * - Caché compartida por todos los reproductores: el mismo vídeo montado dos
 *   veces (o re-montado al saltar a un capítulo) no vuelve a pedir firma
 *   mientras la anterior siga viva. Las peticiones en vuelo se comparten para
 *   no duplicar llamadas (que además cuentan para el tope de la cuenta).
 * - Si la API falla por algo que NO es «no tienes acceso» ni «tope superado»
 *   (API caída, versión antigua sin este endpoint, red), se usa la URL de
 *   siempre, sin firmar. En una academia sin protección el vídeo se ve igual
 *   que antes; en una protegida Bunny rechaza esa URL, así que no se regala
 *   nada. Solo se deja de hacer cuando ya se sabe que la librería está
 *   protegida: ahí la URL sin firmar daría la página de error de Bunny y es
 *   mejor decir «no se pudo cargar».
 */
export function createPlayUrlResolver(deps: PlayUrlResolverDeps) {
  const cache = new Map<string, BunnyPlayUrlEntry>();
  const inFlight = new Map<string, Promise<BunnyPlayUrlEntry>>();
  const protectedLibraries = new Set<string>();

  function unsignedEntry(ref: BunnyRef): BunnyPlayUrlEntry {
    return {
      url: bunnyBaseEmbedUrl(ref),
      expiresAtMs: null,
      fetchedAtMs: deps.now(),
      watermark: false,
    };
  }

  return {
    /** La URL cacheada, solo si todavía se puede montar un reproductor con ella. */
    peek(ref: BunnyRef): BunnyPlayUrlEntry | undefined {
      const entry = cache.get(bunnyRefKey(ref));
      return isPlayUrlFresh(entry, deps.now()) ? entry : undefined;
    },

    resolve(ref: BunnyRef): Promise<BunnyPlayUrlEntry> {
      const key = bunnyRefKey(ref);
      const cached = cache.get(key);
      if (cached && isPlayUrlFresh(cached, deps.now())) return Promise.resolve(cached);
      const pending = inFlight.get(key);
      if (pending) return pending;

      // `Promise.resolve().then`: si `playUrl` lanza en síncrono (sin sesión),
      // el error entra por el mismo `catch` que un fallo de red.
      const promise = Promise.resolve()
        .then(() => deps.playUrl(ref))
        .then((res) => {
          const parsed = res.expiresAt ? Date.parse(res.expiresAt) : null;
          const entry: BunnyPlayUrlEntry = {
            url: res.url,
            expiresAtMs: parsed !== null && Number.isFinite(parsed) ? parsed : null,
            fetchedAtMs: deps.now(),
            watermark: res.watermark === true,
          };
          if (res.protected === true) protectedLibraries.add(ref.libraryId);
          else protectedLibraries.delete(ref.libraryId);
          cache.set(key, entry);
          return entry;
        })
        .catch((error: unknown) => {
          const playError = toPlayUrlError(error);
          if (playError.kind === 'unknown' && !protectedLibraries.has(ref.libraryId)) {
            // No se cachea: el siguiente montaje vuelve a intentarlo con la API.
            return unsignedEntry(ref);
          }
          throw playError;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, promise);
      return promise;
    },
  };
}

export type PlayUrlResolver = ReturnType<typeof createPlayUrlResolver>;

/** El de la página: una caché por pestaña, compartida por todos los reproductores. */
export const playUrlResolver: PlayUrlResolver = createPlayUrlResolver({
  playUrl: (ref) => videoProtectionApi.playUrl(ref),
  now: () => Date.now(),
});
