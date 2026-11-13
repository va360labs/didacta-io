/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Enlaces sociales de la academia en el web: detectar la red del enlace que se
 * pega y avisar ANTES de guardar si no vale.
 *
 * Espejo de `modules/theming/src/social-links.ts` (la API es la que manda y
 * vuelve a validar): el web no depende del paquete del módulo. Si se añade una
 * red o un dominio allí, se añade aquí; el test de este fichero fija la tabla.
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

export const MAX_SOCIAL_LINKS = 5;
export const MAX_SOCIAL_LINK_URL_CHARS = 500;

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

/** Nombre de la red tal cual (son marcas: no se traducen). `web` va por i18n. */
export const SOCIAL_LINK_BRAND: Readonly<Record<Exclude<SocialLinkKind, 'web'>, string>> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  instagram: 'Instagram',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  x: 'X',
};

function parse(raw: string): URL | null {
  const url = raw.trim();
  if (!/^https:\/\//i.test(url) || /\s/.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function hostMatches(hostname: string, domains: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * La red de un enlace por su dominio; `web` si es de otro sitio. Así quien
 * edita solo pega el enlace y el icono sale solo.
 */
export function detectSocialKind(raw: string): SocialLinkKind {
  const u = parse(raw);
  if (!u) return 'web';
  for (const kind of SOCIAL_LINK_KINDS) {
    if (kind !== 'web' && hostMatches(u.hostname, SOCIAL_LINK_HOSTS[kind])) return kind;
  }
  return 'web';
}

/** `null` si el enlace vale para su red; si no, la razón (las mismas que la API). */
export function socialLinkProblem(
  kind: SocialLinkKind,
  raw: string,
): 'https' | 'credentials' | 'host' | 'length' | null {
  if (raw.trim().length > MAX_SOCIAL_LINK_URL_CHARS) return 'length';
  const u = parse(raw);
  if (!u) return 'https';
  if (u.username || u.password) return 'credentials';
  if (!u.hostname.includes('.') || u.hostname.endsWith('.')) return 'host';
  if (kind !== 'web' && !hostMatches(u.hostname, SOCIAL_LINK_HOSTS[kind])) return 'host';
  return null;
}

/** Nombre visible de un enlace: la red, o el dominio si es una web. */
export function socialLinkName(kind: SocialLinkKind, url: string, webFallback: string): string {
  if (kind !== 'web') return SOCIAL_LINK_BRAND[kind];
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return webFallback;
  }
}
