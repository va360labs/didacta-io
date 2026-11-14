/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { CatalogCourse } from './catalog';
import { isPublicSeo, type PublicSeo } from './seo';

/**
 * Lo que necesitan del SERVIDOR del web las páginas indexables y los ficheros
 * para buscadores: la indexación del aula (`GET /api/v1/public/seo`) y el
 * catálogo público, pedidos por loopback con el host del visitante explícito
 * (sin él, la API resolvería el aula de `localhost`) y su IP (sin ella, todo lo
 * que pinta el servidor gastaría el mismo cupo anónimo del rate limit).
 *
 * La indexación se cachea POR HOST (el host en la clave no es un detalle: sin
 * él, el sitemap de la primera aula se serviría a todas) con vida corta; la API
 * cachea por su lado por aula. Un fallo de la API devuelve `null` y se cachea
 * menos: quien llama decide cómo fallar (un `robots.txt` contesta 503, que el
 * buscador lee como «vuelve luego», nunca un «indexa todo» ni un «borra todo»).
 */

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** Vida de una respuesta de la API. */
const TTL_MS = 60_000;
/** Vida de un fallo: se reintenta pronto. */
const TTL_FALLO_MS = 5_000;
/** Las páginas no pueden colgarse por esto. */
const TIMEOUT_MS = 4_000;
/** Tope de hosts en caché (una instancia de Cloud sirve muchas aulas). */
const MAX_HOSTS = 1_000;

interface CacheEntry {
  value: PublicSeo | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Solo para tests: vacía la caché. */
export function clearPublicSeoCache(): void {
  cache.clear();
}

function apiHeaders(host: string, forwardedFor: string | null): Record<string, string> {
  return { 'x-forwarded-host': host, ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) };
}

/** Indexación del aula del host, o `null` si la API no contesta bien. */
export async function fetchPublicSeo(
  host: string | null,
  forwardedFor: string | null,
): Promise<PublicSeo | null> {
  if (!host) return null;
  const now = Date.now();
  const hit = cache.get(host);
  if (hit && hit.expiresAt > now) return hit.value;

  let value: PublicSeo | null = null;
  let ok = false;
  try {
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/public/seo`, {
      headers: apiHeaders(host, forwardedFor),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) {
      // Dominio que no es de ningún aula: no hay nada que indexar.
      value = { indexable: false };
      ok = true;
    } else if (res.ok) {
      const data: unknown = await res.json();
      if (isPublicSeo(data)) {
        value = data;
        ok = true;
      }
    }
  } catch {
    // API caída o lenta: `null`.
  }
  if (cache.size >= MAX_HOSTS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(host);
  cache.set(host, { value, expiresAt: now + (ok ? TTL_MS : TTL_FALLO_MS) });
  return value;
}

/** El curso del catálogo público tal como lo pinta la ficha en el servidor. */
export type ServerCatalogCourse = CatalogCourse & { descriptionHtml: string | null };

/**
 * Catálogo público del aula del host (los cursos a la venta), para pintar en
 * el servidor el catálogo y las fichas. Sin caché aquí: la compra tiene que ver
 * el precio de ahora. `null` si la API no contesta: la página cae al camino de
 * siempre (lo pide el navegador).
 */
export async function fetchPublicCatalog(
  host: string | null,
  forwardedFor: string | null,
): Promise<ServerCatalogCourse[] | null> {
  if (!host) return null;
  try {
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/modules/billing/public/catalog`, {
      headers: apiHeaders(host, forwardedFor),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { courses?: unknown };
    if (!Array.isArray(data.courses)) return null;
    return (data.courses as ServerCatalogCourse[]).map((c) => ({
      ...c,
      // Una API anterior a este campo no lo manda: sin él no se pinta HTML.
      descriptionHtml: typeof c.descriptionHtml === 'string' ? c.descriptionHtml : null,
    }));
  } catch {
    return null;
  }
}

/** La marca pública del aula (lo que ya enseña su pantalla de acceso). */
export interface PublicBrand {
  name: string;
  logoUrl: string | null;
  brandHue: number | null;
  brandSaturation: number | null;
}

/**
 * Nombre, logo y color del aula del host (`GET /api/v1/auth/tenant-context`,
 * el mismo que pide el navegador). Las páginas de venta que se pintan en el
 * servidor los necesitan YA en el HTML: sin el color, el botón de compra salía
 * en el azul de Didacta y cambiaba al del aula al hidratar, con transición
 * incluida. Sin caché: un cambio de color en Ajustes se ve en la siguiente
 * visita. `null` si la API no contesta (el navegador lo pide, como antes).
 */
export async function fetchPublicBrand(
  host: string | null,
  forwardedFor: string | null,
): Promise<PublicBrand | null> {
  if (!host) return null;
  try {
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/auth/tenant-context`, {
      headers: apiHeaders(host, forwardedFor),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tenant?: Record<string, unknown> | null };
    const t = data.tenant;
    if (!t || typeof t.name !== 'string') return null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      name: t.name,
      logoUrl: typeof t.logoUrl === 'string' ? t.logoUrl : null,
      brandHue: num(t.brandHue),
      brandSaturation: num(t.brandSaturation),
    };
  } catch {
    return null;
  }
}

/** Origen público de la petición (`https://aula.ejemplo.com`), o `null`. */
export function requestOrigin(
  headers: { get(name: string): string | null },
  host: string | null,
): string | null {
  if (!host) return null;
  const proto =
    headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    (/^(localhost|127\.|\[::1\])|\.localhost(:|$)/.test(host) ? 'http' : 'https');
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}
