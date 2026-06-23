'use client';

import { useEffect, useState } from 'react';
import { ApiHttpError } from '@/lib/api-client';
import { communityApi, type CommunitySpace } from './client';

let cache: CommunitySpace[] | null = null;
let inflight: Promise<CommunitySpace[]> | null = null;

async function fetchSpaces(): Promise<CommunitySpace[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const list = await communityApi.listSpaces();
      cache = list;
      return list;
    } catch (e) {
      if (e instanceof ApiHttpError && e.status === 404) {
        cache = [];
        return cache;
      }
      cache = [];
      return cache;
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
