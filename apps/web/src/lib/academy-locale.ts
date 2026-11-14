/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { isAcademyLocale, type AcademyLocale } from '@/i18n/config';

/**
 * Idioma del aula de un dominio, desde el SERVIDOR del web (`i18n/request.ts`
 * y el layout raíz). Es el idioma por defecto de quien entra sin cookie de
 * idioma: visitantes de la página de venta, el catálogo, /join, el acceso…
 *
 * Mismo patrón que `site-context.ts`: caché por host (el host en la clave no es
 * un detalle: sin él, el idioma de la primera aula se serviría a todas) y TTL
 * corto, para que cambiar el idioma en Ajustes se note sin reiniciar. Un fallo
 * de la API se cachea menos tiempo y deja el último idioma bueno de ese host
 * (o, si nunca lo hubo, el idioma por defecto): fallamos hacia lo que había,
 * no hacia algo nuevo.
 *
 * La IP del visitante viaja en `X-Forwarded-For`. Sin ella la API ve la del
 * propio servidor del web (loopback), y TODAS las aulas de la instancia
 * compartían un único cupo anónimo de 30 peticiones/min: con unas pocas aulas
 * con visitas a la vez, el idioma de todas caía al de por defecto.
 */

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** Vida de una respuesta de la API. */
const TTL_MS = 30_000;
/** Vida de un fallo (API caída o lenta): se reintenta pronto. */
const TTL_FALLO_MS = 5_000;
/** El idioma no puede retrasar la página: si la API tarda, se sigue sin él. */
const TIMEOUT_MS = 1_500;

interface CacheEntry {
  value: AcademyLocale | null;
  expiresAt: number;
  /** La respuesta vino de la API (no es la reserva de un fallo). */
  ok: boolean;
}

const cache = new Map<string, CacheEntry>();

/** Solo para tests: vacía la caché. */
export function clearAcademyLocaleCache(): void {
  cache.clear();
}

/**
 * Cabeceras de una llamada del servidor del web a la API en nombre de un
 * visitante: su host (para resolver el aula) y su `X-Forwarded-For` tal como
 * llegó (la API se queda con la entrada que pone el proxy propio, ver
 * `apps/api/src/common/trust-proxy.ts`).
 */
export function forwardedHeaders(
  host: string,
  forwardedFor: string | null,
): Record<string, string> {
  const xff = forwardedFor?.trim();
  return { 'x-forwarded-host': host, ...(xff ? { 'x-forwarded-for': xff } : {}) };
}

/** Host público de la petición (el del visitante, no el del salto interno). */
export function publicHost(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!raw) return null;
  const host = (raw.split(',')[0] ?? raw).trim().toLowerCase();
  return host || null;
}

/**
 * Idioma del aula del host, o `null` si no se sabe (host ajeno, API caída sin
 * respuesta buena previa). `forwardedFor` es el `X-Forwarded-For` de la
 * petición del visitante.
 */
export async function getAcademyLocale(
  host: string | null,
  forwardedFor: string | null = null,
): Promise<AcademyLocale | null> {
  if (!host) return null;
  const now = Date.now();
  const cached = cache.get(host);
  if (cached && cached.expiresAt > now) return cached.value;

  const { value, ok } = await fetchAcademyLocale(host, forwardedFor);
  if (ok) {
    cache.set(host, { value, expiresAt: now + TTL_MS, ok: true });
    return value;
  }
  // Fallo (429, API caída): el último idioma bueno de este host, si lo hubo.
  const stale = cached?.ok ? cached.value : null;
  cache.set(host, { value: stale, expiresAt: now + TTL_FALLO_MS, ok: cached?.ok ?? false });
  return stale;
}

async function fetchAcademyLocale(
  host: string,
  forwardedFor: string | null,
): Promise<{ value: AcademyLocale | null; ok: boolean }> {
  try {
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/tenancy/locale`, {
      // La llamada sale por loopback: el host del visitante viaja explícito o
      // la API resolvería el aula de `localhost`; su IP, para que el rate
      // limit la cuente a él y no al servidor del web.
      headers: forwardedHeaders(host, forwardedFor),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { value: null, ok: false };
    const data = (await res.json()) as { locale?: unknown };
    return { value: isAcademyLocale(data.locale) ? data.locale : null, ok: true };
  } catch {
    return { value: null, ok: false };
  }
}
