/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Enlaces sociales de la academia (tarjeta de /community, como en Skool).
 *
 * Se pintan con el icono de su red y abren en pestaña nueva, así que el icono
 * PROMETE un destino: un «WhatsApp» que lleve a otro dominio sería un engaño
 * servido con la marca del aula. Por eso cada red solo acepta sus dominios
 * (con sus subdominios: `www.`, `m.`, `es.`…) y `web` acepta cualquier https.
 *
 * El web tiene un espejo de esta tabla para detectar la red al pegar el enlace
 * (`apps/web/src/lib/social-links.ts`); la que manda es esta.
 */

export const SOCIAL_LINK_KINDS = [
  'whatsapp',
  'telegram',
  'instagram',
  'youtube',
  'tiktok',
  'facebook',
  'linkedin',
  'x',
  'web',
] as const;
export type SocialLinkKind = (typeof SOCIAL_LINK_KINDS)[number];

export interface SocialLink {
  kind: SocialLinkKind;
  url: string;
}

/** Como Skool: unos pocos enlaces, no una lista de marcadores. */
export const MAX_SOCIAL_LINKS = 5;
/** Un enlace de perfil o de invitación no se acerca a esto. */
export const MAX_SOCIAL_LINK_URL_CHARS = 500;

/**
 * Dominios de cada red. WhatsApp: `wa.me/<número>`, los grupos de
 * `chat.whatsapp.com` y los canales de `whatsapp.com/channel/…`.
 */
export const SOCIAL_LINK_HOSTS: Readonly<
  Record<Exclude<SocialLinkKind, 'web'>, readonly string[]>
> = {
  whatsapp: ['wa.me', 'whatsapp.com'],
  telegram: ['t.me', 'telegram.me', 'telegram.dog'],
  instagram: ['instagram.com', 'instagr.am'],
  youtube: ['youtube.com', 'youtu.be'],
  tiktok: ['tiktok.com'],
  facebook: ['facebook.com', 'fb.com', 'fb.me'],
  linkedin: ['linkedin.com', 'lnkd.in'],
  x: ['x.com', 'twitter.com'],
};

function hostMatches(hostname: string, domains: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Por qué un enlace no vale, o `null` si vale. Razones estables (se usan como
 * `detail` del error y en los tests):
 *  - `https`: no es una URL `https://` bien formada (http, javascript:, data:…).
 *  - `credentials`: lleva usuario/contraseña (`https://wa.me@evil.com`).
 *  - `host`: el dominio no es de la red elegida.
 *  - `length`: más larga de lo razonable.
 */
export function socialLinkProblem(
  kind: SocialLinkKind,
  rawUrl: string,
): 'https' | 'credentials' | 'host' | 'length' | null {
  const url = rawUrl.trim();
  if (url.length > MAX_SOCIAL_LINK_URL_CHARS) return 'length';
  if (!/^https:\/\//i.test(url) || /\s/.test(url)) return 'https';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'https';
  }
  if (parsed.protocol !== 'https:') return 'https';
  if (parsed.username || parsed.password) return 'credentials';
  const host = parsed.hostname;
  // Un host sin punto (localhost, intranet) no es un enlace que compartir.
  if (!host.includes('.') || host.endsWith('.')) return 'host';
  if (kind !== 'web' && !hostMatches(host, SOCIAL_LINK_HOSTS[kind])) return 'host';
  return null;
}

/**
 * Lee la columna JSON tal como venga (edición a mano, versión vieja) y se
 * queda SOLO con los enlaces válidos, en orden y sin pasar del máximo. Nunca
 * propaga al front un enlace que el DTO no habría aceptado.
 */
export function parseSocialLinks(value: unknown): SocialLink[] {
  if (!Array.isArray(value)) return [];
  const out: SocialLink[] = [];
  for (const item of value) {
    if (out.length >= MAX_SOCIAL_LINKS) break;
    if (!item || typeof item !== 'object') continue;
    const { kind, url } = item as { kind?: unknown; url?: unknown };
    if (typeof kind !== 'string' || typeof url !== 'string') continue;
    if (!(SOCIAL_LINK_KINDS as readonly string[]).includes(kind)) continue;
    if (socialLinkProblem(kind as SocialLinkKind, url) !== null) continue;
    out.push({ kind: kind as SocialLinkKind, url: url.trim() });
  }
  return out;
}
