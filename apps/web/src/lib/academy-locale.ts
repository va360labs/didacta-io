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
 * de la API se cachea menos tiempo y deja el idioma por defecto: fallamos hacia
 * lo que había, no hacia algo nuevo.
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
}

const cache = new Map<string, CacheEntry>();

/** Solo para tests: vacía la caché. */
export function clearAcademyLocaleCache(): void {
  cache.clear();
}

/** Host público de la petición (el del visitante, no el del salto interno). */
export function publicHost(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!raw) return null;
  const host = (raw.split(',')[0] ?? raw).trim().toLowerCase();
  return host || null;
}

/** Idioma del aula del host, o `null` si no se sabe (host ajeno, API caída). */
export async function getAcademyLocale(host: string | null): Promise<AcademyLocale | null> {
  if (!host) return null;
  const now = Date.now();
  const cached = cache.get(host);
  if (cached && cached.expiresAt > now) return cached.value;

  const { value, ok } = await fetchAcademyLocale(host);
  cache.set(host, { value, expiresAt: now + (ok ? TTL_MS : TTL_FALLO_MS) });
  return value;
}

async function fetchAcademyLocale(
  host: string,
): Promise<{ value: AcademyLocale | null; ok: boolean }> {
  try {
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/tenancy/locale`, {
      // La llamada sale por loopback: el host del visitante viaja explícito o
      // la API resolvería el aula de `localhost`.
      headers: { 'x-forwarded-host': host },
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
