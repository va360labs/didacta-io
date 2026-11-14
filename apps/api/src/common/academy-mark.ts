/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * MARCA POR DEFECTO DEL AULA en los correos: sus iniciales sobre su color
 * cuando no tiene logo (nunca el logo de Didacta), y el pie «Powered by
 * Didacta — Crea tu academia gratis» enlazado al alta de didacta.io con la
 * campaña del aula. Decisión de Valentín, 14-nov-2026.
 *
 * Gemela de `apps/web/src/lib/academy-mark.ts` (la web no comparte paquete con
 * la API): las dos sacan las mismas iniciales y los mismos colores, y sus tests
 * comparten la misma tabla de casos. Si cambias una, cambia la otra.
 */

import type { EmailLang } from './branded-email';

const WORD_SEPARATOR = /[\s\-‐-―_/\\|·•.,:;&+]+/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]/u;

/** Marca combinante (el acento suelto de una «e» + «´» que no se compuso). */
const COMBINING_MARK = /^\p{M}$/u;

/**
 * La primera letra o cifra de una palabra, con sus acentos combinantes si los
 * trae sueltos (tras `normalize('NFC')` casi nunca: «É» ya es una sola letra);
 * `null` si la palabra no tiene ninguna (un emoji, un signo).
 */
function firstLetter(word: string): string | null {
  const chars = Array.from(word);
  for (let i = 0; i < chars.length; i++) {
    if (!LETTER_OR_DIGIT.test(chars[i]!)) continue;
    let letter = chars[i]!;
    for (let j = i + 1; j < chars.length && COMBINING_MARK.test(chars[j]!); j++) {
      letter += chars[j]!;
    }
    return letter;
  }
  return null;
}

/** Mayúscula de una letra sin convertirla en dos («ß» no pasa a «SS»). */
function upper(letter: string): string {
  const up = letter.toLocaleUpperCase();
  return Array.from(up).length === Array.from(letter).length ? up : letter;
}

/**
 * Iniciales de un aula (1-2 letras): la primera y la última palabra, con su
 * tilde, sin emojis ni signos. `''` si el nombre no tiene letras.
 */
export function academyInitials(name: string | null | undefined): string {
  const clean = (name ?? '').normalize('NFC').trim();
  if (!clean) return '';
  const letters = clean
    .split(WORD_SEPARATOR)
    .map(firstLetter)
    .filter((l): l is string => l !== null);
  if (letters.length === 0) return '';
  const picked = letters.length === 1 ? [letters[0]!] : [letters[0]!, letters[letters.length - 1]!];
  return picked.map(upper).join('');
}

export const DEFAULT_BRAND_HUE = 213;
export const DEFAULT_BRAND_SATURATION = 70;
export const MARK_LIGHT_TEXT = '#FFFFFF';
export const MARK_DARK_TEXT = '#111827';
export const MIN_MARK_CONTRAST = 4.5;

export interface MarkColors {
  background: string;
  foreground: string;
}

/** HSL (0-360, 0-100, 0-100) → `#RRGGBB`. */
export function markHslToHex(h: number, s: number, l: number): string {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lig = Math.max(0, Math.min(100, l)) / 100;
  const hue = ((h % 360) + 360) % 360;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const c = lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

function channel(hex: string, i: number): number {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

/** Contraste WCAG entre dos `#RRGGBB` (1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Colores del monograma: fondo en el tono de los botones del aula (saturación
 * +2, luminosidad 38 %), letras blancas si se leen (≥ 4,5:1), si no casi negras,
 * y si ni así se oscurece el fondo. Mismo cálculo que la web.
 */
export function academyMarkColors(hue: unknown, saturation: unknown): MarkColors {
  const h =
    typeof hue === 'number' && Number.isFinite(hue) && hue >= 0 && hue <= 360
      ? hue
      : DEFAULT_BRAND_HUE;
  const rawS =
    typeof saturation === 'number' &&
    Number.isFinite(saturation) &&
    saturation >= 0 &&
    saturation <= 100
      ? saturation
      : DEFAULT_BRAND_SATURATION;
  const s = Math.min(100, rawS + 2);
  for (let l = 38; l >= 0; l -= 2) {
    const background = markHslToHex(h, s, l);
    if (contrastRatio(background, MARK_LIGHT_TEXT) >= MIN_MARK_CONTRAST) {
      return { background, foreground: MARK_LIGHT_TEXT };
    }
    if (contrastRatio(background, MARK_DARK_TEXT) >= MIN_MARK_CONTRAST) {
      return { background, foreground: MARK_DARK_TEXT };
    }
  }
  return { background: '#000000', foreground: MARK_LIGHT_TEXT };
}

/** La marca del aula para la cabecera de un correo sin logo. */
export interface AcademyEmailMark {
  initials: string;
  background: string;
  foreground: string;
}

export function academyEmailMark(
  name: string,
  hue: unknown,
  saturation: unknown,
): AcademyEmailMark | null {
  const initials = academyInitials(name);
  if (!initials) return null;
  return { initials, ...academyMarkColors(hue, saturation) };
}

// ── Powered by Didacta ───────────────────────────────────────────────────────

const POWERED_BY: Readonly<Record<EmailLang, string>> = {
  es: 'Powered by Didacta — Crea tu academia gratis',
  en: 'Powered by Didacta — Create your own academy free',
  pt: 'Powered by Didacta — Crie sua escola grátis',
};

const SITE_LANG: Readonly<Record<EmailLang, string>> = { es: 'es', en: 'en', pt: 'pt-br' };

/** Texto del pie en el idioma del correo. */
export function poweredByText(lang: EmailLang): string {
  return POWERED_BY[lang];
}

/**
 * Enlace del pie: el alta de didacta.io en el idioma del correo, con la campaña
 * del aula (`utm_campaign=<slug>`). Sin slug, sin campaña.
 */
export function poweredByHref(lang: EmailLang, slug: string | null | undefined): string {
  const url = new URL(`https://didacta.io/${SITE_LANG[lang]}/start`);
  url.searchParams.set('utm_source', 'aula');
  url.searchParams.set('utm_medium', 'powered_by');
  const campaign = slug?.trim();
  if (campaign) url.searchParams.set('utm_campaign', campaign);
  return url.toString();
}
