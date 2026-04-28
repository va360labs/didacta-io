'use client';

import { useEffect, useState } from 'react';
import { ApiHttpError } from './api-client';
import { communityApi, type CommunityTag } from './community';

/**
 * Cache module-level de los tags curados del tenant. Como la sesión sólo
 * tiene un tenant a la vez, basta con cachearlos en una variable de módulo
 * en vez de un Context. La primera vista que monta el hook hace el fetch;
 * las siguientes obtienen el snapshot cacheado de inmediato.
 *
 * Si en el futuro un admin crea un tag mientras tiene la otra ventana
 * abierta, el feed lo verá tras un reload. Para invalidación cross-tab
 * habría que usar BroadcastChannel; por ahora no es necesario.
 */
let cache: ReadonlyMap<string, CommunityTag> | null = null;
let inflight: Promise<ReadonlyMap<string, CommunityTag>> | null = null;

async function fetchTags(): Promise<ReadonlyMap<string, CommunityTag>> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const list = await communityApi.listTags();
      const map = new Map<string, CommunityTag>();
      for (const t of list) map.set(t.name, t);
      cache = map;
      return map;
    } catch (e) {
      // Si la carga falla (404 si community no está habilitado para el
      // viewer, 401, etc.) cacheamos un map vacío para que la UI caiga al
      // estilo genérico sin reintentar en cada chip.
      if (e instanceof ApiHttpError && e.status === 404) {
        cache = new Map();
        return cache;
      }
      cache = new Map();
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Devuelve el map nombre → tag curado del tenant. Mientras carga devuelve
 * un map vacío (la UI muestra el estilo genérico). Tras la carga inicial
 * el map permanece estable hasta que el usuario refresque la página.
 */
export function useCommunityTags(): ReadonlyMap<string, CommunityTag> {
  const [byName, setByName] = useState<ReadonlyMap<string, CommunityTag>>(() => cache ?? new Map());

  useEffect(() => {
    let aborted = false;
    void fetchTags().then((map) => {
      if (!aborted) setByName(map);
    });
    return () => {
      aborted = true;
    };
  }, []);

  return byName;
}

/** Permite a admin/UI invalidar el cache después de crear/editar/borrar. */
export function invalidateCommunityTagsCache() {
  cache = null;
}
