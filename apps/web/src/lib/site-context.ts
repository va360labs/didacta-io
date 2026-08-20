/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PublicSiteContext } from './module-registry';

/**
 * Contexto del sitio público, resuelto por dominio.
 *
 * Lo consultan dos sitios con necesidades distintas:
 *
 *   - el middleware, para decidir si una petición va al sitio o al aula. Ahí
 *     importa que sea barato: corre en CADA petición.
 *   - la página, para renderizar. Ahí importa que sea correcto: el middleware
 *     reparte, pero NO autoriza. La página vuelve a resolver por su cuenta,
 *     porque en Next el layout y la página se renderizan en paralelo y fiarse
 *     de un paso anterior es cómo se cuelan las fugas.
 *
 * La caché va indexada por host y con un TTL corto. El host en la clave no es
 * un detalle: sin él, la primera respuesta que entre se sirve a todos los
 * dominios de la instancia.
 */

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** Vida de una entrada de caché. Corto: mover un dominio no debe exigir reinicio. */
const TTL_MS = 30_000;

interface CacheEntry {
  value: PublicSiteContext | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Solo para tests: vacía la caché. */
export function clearSiteContextCache(): void {
  cache.clear();
}

/**
 * Devuelve el contexto del sitio para un host, o `null` si ese host no sirve
 * un sitio público (dominio desconocido, o dominio del aula).
 *
 * El `null` también se cachea, a propósito: si no, un host inexistente
 * golpearía la API en cada petición y sería un amplificador gratuito.
 */
export async function getSiteContext(host: string | null): Promise<PublicSiteContext | null> {
  if (!host) return null;

  const now = Date.now();
  const cached = cache.get(host);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await fetchSiteContext(host);
  cache.set(host, { value, expiresAt: now + TTL_MS });
  return value;
}

async function fetchSiteContext(host: string): Promise<PublicSiteContext | null> {
  try {
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/public/site-context`, {
      // El host que importa es el del visitante, y la llamada sale por
      // loopback: hay que reenviarlo explícitamente o la API resolvería el
      // tenant contra `localhost` (ver `resolve-request-host.ts` en la API).
      headers: { 'x-forwarded-host': host },
      cache: 'no-store',
    });

    if (res.status === 404) return null;
    if (!res.ok) return null;

    return (await res.json()) as PublicSiteContext;
  } catch {
    // Sin API no se puede afirmar que un dominio sirva el sitio. Devolver
    // `null` deja la petición en el aula, que es el comportamiento que ya
    // había: fallamos hacia lo conocido, no hacia lo nuevo.
    return null;
  }
}
