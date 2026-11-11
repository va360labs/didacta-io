'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { bunnyRefKey, type BunnyRef } from '@/lib/video';
import { playUrlResolver, toPlayUrlError, type PlayUrlError } from '@/lib/video-protection';

export interface BunnyPlayUrlState {
  /** URL de embed lista para el iframe (sin parámetros de reproductor), o null. */
  url: string | null;
  /** Hay que pintar la marca de agua con la identidad del alumno. */
  watermark: boolean;
  error: PlayUrlError | null;
  loading: boolean;
}

const IDLE: BunnyPlayUrlState = { url: null, watermark: false, error: null, loading: false };

/**
 * Pide (o reutiliza) la URL de reproducción de un vídeo de Bunny: firmada si la
 * academia protege sus vídeos, la de siempre si no.
 *
 * `refreshKey` fuerza a revisar la caducidad: el reproductor lo cambia al
 * re-montar el iframe (salto a un capítulo), porque la firma solo se valida al
 * cargar el iframe y una caducada daría un reproductor en blanco.
 */
export function useBunnyPlayUrl(ref: BunnyRef | null, refreshKey: number = 0): BunnyPlayUrlState {
  const key = ref ? bunnyRefKey(ref) : null;
  const [state, setState] = useState<BunnyPlayUrlState>(() => {
    const cached = ref ? playUrlResolver.peek(ref) : undefined;
    return cached
      ? { url: cached.url, watermark: cached.watermark, error: null, loading: false }
      : { ...IDLE, loading: Boolean(key) };
  });

  useEffect(() => {
    if (!ref || !key) {
      setState(IDLE);
      return;
    }
    const cached = playUrlResolver.peek(ref);
    if (cached) {
      setState({ url: cached.url, watermark: cached.watermark, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ ...IDLE, loading: true });
    playUrlResolver
      .resolve(ref)
      .then((entry) => {
        if (!cancelled) {
          setState({ url: entry.url, watermark: entry.watermark, error: null, loading: false });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ ...IDLE, error: toPlayUrlError(error) });
      });
    return () => {
      cancelled = true;
    };
    // `ref` se identifica por `key`; refreshKey re-evalúa la caducidad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey]);

  return state;
}
