/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { SocialLink } from './social-links';

/**
 * Página pública de la academia (`/` sin sesión), desde el SERVIDOR del web.
 *
 * Lo pide la raíz del aula en cada visita, con el host del visitante explícito
 * (la llamada sale por loopback: sin él, la API resolvería el aula de
 * `localhost`) y su IP en `X-Forwarded-For` (sin ella, todas las portadas que
 * pinta el servidor gastarían el mismo cupo anónimo del rate limit). La API
 * cachea por aula; aquí no se cachea para que el ajuste se note al momento.
 *
 * Un fallo de la API devuelve `null`: la raíz se comporta como siempre (acceso).
 */

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
/** La portada no puede colgarse por la API: si tarda, la raíz va al acceso. */
const TIMEOUT_MS = 4_000;

export interface AcademyHomePrice {
  amountCents: number;
  currency: string;
  compareAtCents: number | null;
  discountPercent: number | null;
}

export interface AcademyHomeCourse {
  slug: string;
  title: string;
  excerpt: string | null;
  thumbnailUrl: string | null;
  estimatedMinutes: number | null;
  price: AcademyHomePrice;
  optionCount: number;
}

export interface AcademyHomeMembership {
  headline: string | null;
  subheadline: string | null;
  plan: {
    name: string;
    amountCents: number;
    currency: string;
    compareAtCents: number | null;
    intervalMonths: number;
    trialDays: number;
  };
  planCount: number;
  courseCount: number | null;
}

export interface AcademyHome {
  enabled: true;
  academy: {
    name: string;
    logoUrl: string | null;
    logoDisplayMode: 'logo_only' | 'logo_and_name';
    coverUrl: string | null;
    description: string | null;
    host: string | null;
    links: SocialLink[];
    brandHue: number | null;
    brandSaturation: number | null;
  };
  members: number | null;
  creator: { name: string; avatarUrl: string | null } | null;
  nextLive: { title: string; startTime: string; durationMinutes: number } | null;
  offers: {
    courses: AcademyHomeCourse[];
    coursesTotal: number;
    membership: AcademyHomeMembership | null;
    free: { courses: Array<{ slug: string; title: string; thumbnailUrl: string | null }> } | null;
  };
}

export type AcademyHomeResponse = { enabled: false } | AcademyHome;

/** Datos de la portada del aula del host, o `null` si la API no contesta. */
export async function fetchAcademyHome(
  host: string | null,
  forwardedFor: string | null,
): Promise<AcademyHomeResponse | null> {
  if (!host) return null;
  try {
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/public/academy-home`, {
      headers: {
        'x-forwarded-host': host,
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as AcademyHomeResponse;
    return data && typeof data.enabled === 'boolean' ? data : null;
  } catch {
    return null;
  }
}

/** Código de referido de la URL (`?ref=`), con el formato que acepta la API. */
export function referralFromQuery(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  return /^[a-z0-9]{3,32}$/.test(code) ? code : null;
}

/** La ruta con el `?ref=` del visitante, si lo trae (se conserva en todos los botones). */
export function withRef(path: string, ref: string | null): string {
  if (!ref || path.startsWith('#')) return path;
  return `${path}${path.includes('?') ? '&' : '?'}ref=${encodeURIComponent(ref)}`;
}

export type PrimaryAccess =
  | { kind: 'membership'; href: string }
  | { kind: 'course'; href: string }
  | { kind: 'courses'; href: string }
  | { kind: 'free'; href: string }
  | null;

/** Ruta pública de la solicitud de alta (mod.member-registration). */
export const FREE_ACCESS_PATH = '/member-registration';

/**
 * El botón principal de la cabecera: la membresía si la hay (da acceso a todo);
 * si no, el curso a la venta (o la lista si hay varios); si no, el acceso
 * gratuito. `null` si no hay nada: solo queda «Entrar».
 */
export function primaryAccess(home: AcademyHome, ref: string | null): PrimaryAccess {
  const { membership, courses, coursesTotal, free } = home.offers;
  if (membership) return { kind: 'membership', href: withRef('/join', ref) };
  if (coursesTotal === 1 && courses[0]) {
    return {
      kind: 'course',
      href: withRef(`/catalog/${encodeURIComponent(courses[0].slug)}`, ref),
    };
  }
  if (coursesTotal > 1) return { kind: 'courses', href: '#courses' };
  if (free) return { kind: 'free', href: withRef(FREE_ACCESS_PATH, ref) };
  return null;
}

/** ¿El aula tiene alguna opción de acceso además de «Entrar»? */
export function hasAccessOptions(home: AcademyHome): boolean {
  return primaryAccess(home, null) !== null;
}

/** Estilo del color del aula (dos números validados), para pintar sin parpadeo. */
export function brandStyle(hue: unknown, saturation: unknown): string | null {
  const h = typeof hue === 'number' && Number.isFinite(hue) ? Math.round(hue) : null;
  if (h === null || h < 0 || h > 360) return null;
  const s =
    typeof saturation === 'number' && Number.isFinite(saturation) ? Math.round(saturation) : null;
  const sat = s !== null && s >= 0 && s <= 100 ? `--brand-s: ${s}%;` : '';
  return `:root { --brand-h: ${h}; ${sat} }`;
}

/** Iniciales de un nombre, para el avatar sin foto. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]![0], parts[parts.length - 1]![0]] : [parts[0]?.[0]];
  return letters.filter(Boolean).join('').toUpperCase();
}
