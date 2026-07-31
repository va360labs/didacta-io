'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { communityApi, type CommunitySpace } from './client';

let cache: CommunitySpace[] | null = null;
let inflight: Promise<CommunitySpace[]> | null = null;

async function fetchSpaces(): Promise<CommunitySpace[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const list = await communityApi.listSpaces();
      // Solo cacheamos respuestas correctas. Antes cacheábamos `[]` también en
      // error (p.ej. un fetch con token caducado justo antes de re-loguear), y
      // como `[]` es truthy ese cache vacío persistía entre navegaciones SPA →
      // los espacios no aparecían tras el login hasta recargar la página. Al no
      // cachear el error, el siguiente montaje (ya con token válido) reintenta.
      cache = list;
      return list;
    } catch {
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Devuelve los espacios de comunidad del tenant ordenados por sortOrder.
 * Mientras carga devuelve un array vacío. Cacheado en memoria hasta reload.
 * Se refresca automáticamente al recibir el evento `didacta:spaces-changed`.
 */
export function useCommunitySpaces(): CommunitySpace[] {
  const [spaces, setSpaces] = useState<CommunitySpace[]>(() => cache ?? []);

  useEffect(() => {
    let aborted = false;
    void fetchSpaces().then((list) => {
      if (!aborted) setSpaces(list);
    });
    return () => {
      aborted = true;
    };
  }, []);

  useEffect(() => {
    function handler() {
      void fetchSpaces().then(setSpaces);
    }
    window.addEventListener('didacta:spaces-changed', handler);
    return () => window.removeEventListener('didacta:spaces-changed', handler);
  }, []);

  return spaces;
}

export function invalidateCommunitySpacesCache() {
  cache = null;
}
