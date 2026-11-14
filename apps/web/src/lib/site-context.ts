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
/** Vida de un fallo de la API (429, 5xx, caída): se reintenta pronto. */
const TTL_FALLO_MS = 5_000;

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
export async function getSiteContext(
  host: string | null,
  forwardedFor: string | null = null,
): Promise<PublicSiteContext | null> {
  if (!host) return null;

  const now = Date.now();
  const cached = cache.get(host);
  if (cached && cached.expiresAt > now) return cached.value;

  const { value, ok } = await fetchSiteContext(host, forwardedFor);
  if (ok) {
    cache.set(host, { value, expiresAt: now + TTL_MS });
    return value;
  }
  // Fallo de la API: lo último que se supo de este dominio, y se vuelve a
  // preguntar enseguida. Antes un 429 se guardaba como «no hay sitio» 30 s.
  const stale = cached?.value ?? null;
  cache.set(host, { value: stale, expiresAt: now + TTL_FALLO_MS });
  return stale;
}

async function fetchSiteContext(
  host: string,
  forwardedFor: string | null,
): Promise<{ value: PublicSiteContext | null; ok: boolean }> {
  try {
    const xff = forwardedFor?.trim();
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/public/site-context`, {
      // El host que importa es el del visitante, y la llamada sale por
      // loopback: hay que reenviarlo explícitamente o la API resolvería el
      // tenant contra `localhost` (ver `resolve-request-host.ts` en la API).
      // Su IP también: sin ella, el rate limit cuenta la llamada a la IP del
      // servidor del web, un cupo que comparten todas las aulas.
      headers: { 'x-forwarded-host': host, ...(xff ? { 'x-forwarded-for': xff } : {}) },
      cache: 'no-store',
    });

    if (res.status === 404) return { value: null, ok: true };
    if (!res.ok) return { value: null, ok: false };

    return { value: (await res.json()) as PublicSiteContext, ok: true };
  } catch {
    // Sin API no se puede afirmar que un dominio sirva el sitio. Devolver
    // `null` deja la petición en el aula, que es el comportamiento que ya
    // había: fallamos hacia lo conocido, no hacia lo nuevo.
    return { value: null, ok: false };
  }
}
