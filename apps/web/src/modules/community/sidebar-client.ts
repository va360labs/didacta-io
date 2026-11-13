'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { authStorage } from '@/lib/auth-storage';
import { THEME_UPDATED_EVENT } from '@/lib/theming';
import { communityApi, type CommunitySidebar } from './client';

/**
 * Barra lateral del feed: UNA llamada, cacheada en memoria por aula.
 *
 * Volver a /community dentro del minuto pinta lo que ya había y no pregunta;
 * pasado el minuto pinta lo cacheado al instante (sin esqueletos ni saltos) y
 * lo refresca por detrás. Nunca toca el feed: es su propia llamada y su estado.
 */

const FRESH_MS = 60_000;

interface Entry {
  tenantId: string;
  at: number;
  data: CommunitySidebar;
}

let cache: Entry | null = null;
let inflight: Promise<CommunitySidebar | null> | null = null;

function currentTenant(): string | null {
  return authStorage.getSession()?.user.tenantId ?? null;
}

function cached(): CommunitySidebar | null {
  const tenantId = currentTenant();
  return cache && tenantId && cache.tenantId === tenantId ? cache.data : null;
}

async function load(): Promise<CommunitySidebar | null> {
  if (inflight) return inflight;
  const tenantId = currentTenant();
  inflight = (async () => {
    try {
      const data = await communityApi.getSidebar();
      if (tenantId) cache = { tenantId, at: Date.now(), data };
      return data;
    } catch {
      // Sin barra no pasa nada: el feed sigue. No se cachea el fallo.
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * `undefined` mientras carga la primera vez, `null` si falló (la barra se
 * queda solo con lo que no depende de esta llamada), o los datos.
 */
export function useCommunitySidebar(): CommunitySidebar | null | undefined {
  const [data, setData] = useState<CommunitySidebar | null | undefined>(
    () => cached() ?? undefined,
  );

  useEffect(() => {
    let aborted = false;
    const tenantId = currentTenant();
    const fresh = cache && cache.tenantId === tenantId && Date.now() - cache.at < FRESH_MS;
    if (fresh) {
      setData(cache!.data);
      return;
    }
    void load().then((d) => {
      if (aborted) return;
      // Si falla un refresco, se queda lo que ya se veía.
      setData((prev) => d ?? prev ?? null);
    });
    return () => {
      aborted = true;
    };
  }, []);

  return data;
}

/** Olvida la barra cacheada (p. ej. tras cambiar la marca del aula). */
export function invalidateCommunitySidebarCache(): void {
  cache = null;
}

// Cambiar la marca (Ajustes sencillos o /admin/branding) invalida la tarjeta:
// al volver a la comunidad se ve el logo y el nombre nuevos.
if (typeof window !== 'undefined') {
  window.addEventListener(THEME_UPDATED_EVENT, invalidateCommunitySidebarCache);
  window.addEventListener('didacta:empieza-cambio', invalidateCommunitySidebarCache);
}
