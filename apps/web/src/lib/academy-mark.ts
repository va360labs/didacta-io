/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * La MARCA POR DEFECTO de un aula, en piezas puras (sin React ni `next/*`: las
 * usan los componentes, las rutas que generan el favicon y la imagen para
 * redes, y los tests).
 *
 * Decisión de Valentín (14-nov-2026, sustituye a la del 12-nov): si el creador
 * no sube un logo, su aula enseña SUS INICIALES sobre SU color, nunca el logo
 * de Didacta. Didacta solo aparece en el pie, con «Powered by Didacta — Crea tu
 * academia gratis» (`poweredByHref`).
 *
 * La API redacta los correos con la misma regla: su gemela es
 * `apps/api/src/common/academy-mark.ts` y los dos ficheros de tests comparten
 * la misma tabla de casos. Si cambias una, cambia la otra.
 */

// ── Iniciales ────────────────────────────────────────────────────────────────

/**
 * Lo que separa palabras en el nombre de un aula: espacios y los signos con los
 * que se escriben nombres compuestos («Yoga-Pilates», «Arte & Diseño»).
 */
const WORD_SEPARATOR = /[\s\-‐-―_/\\|·•.,:;&+]+/u;

/** Una letra o una cifra de cualquier alfabeto (no un emoji ni un signo). */
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
 * Iniciales de un aula: 1 o 2 letras.
 *
 *  - Una palabra → su inicial («Potenzia» → «P»).
 *  - Varias → la primera y la última («Academia de Yoga» → «AY»), como el
 *    monograma de un grupo de Skool.
 *  - Las tildes se conservan («Ágora Escuela» → «ÁE»), también si vienen
 *    descompuestas (la «E» seguida del acento combinado).
 *  - Emojis y signos no cuentan («🚀 Cohete» → «C», «¡Hola Mundo!» → «HM»).
 *
 * Cadena vacía si el nombre no tiene ninguna letra ni cifra (o no hay nombre):
 * quien pinta la marca usa entonces el símbolo neutro (`NEUTRAL_GLYPH_PATHS`).
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

// ── Color ────────────────────────────────────────────────────────────────────

/** El color por defecto de cualquier aula (`--brand-h`/`--brand-s` de globals.css). */
export const DEFAULT_BRAND_HUE = 213;
export const DEFAULT_BRAND_SATURATION = 70;

export interface MarkColors {
  /** Fondo del monograma, en HEX. */
  background: string;
  /** Color de las letras, en HEX. */
  foreground: string;
}

export const MARK_LIGHT_TEXT = '#FFFFFF';
export const MARK_DARK_TEXT = '#111827';

/** Contraste mínimo de las letras sobre el fondo (WCAG AA, texto normal). */
export const MIN_MARK_CONTRAST = 4.5;

/**
 * Aula sin nombre todavía: un gris pizarra con el símbolo neutro. Ni el color
 * de nadie ni el logo de Didacta.
 */
export const NEUTRAL_MARK_COLORS: MarkColors = {
  background: '#64748B',
  foreground: MARK_LIGHT_TEXT,
};

/** HSL (0-360, 0-100, 0-100) → HEX. */
export function hslToHex(h: number, s: number, l: number): string {
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

/** Luminancia relativa (WCAG 2.x) de un `#RRGGBB`. */
export function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

/** Contraste WCAG entre dos `#RRGGBB` (1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function validHue(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 360 ? v : null;
}

function validSaturation(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

/**
 * Colores del monograma de un aula con su color de marca (`brandHue`,
 * `brandSaturation` de mod.theming; sin ellos, los de por defecto).
 *
 * El fondo es el tono de sus botones (`--color-brand-600`: misma saturación +2
 * y luminosidad 38 %). Las letras van en blanco, como en los botones, si se
 * leen bien (contraste ≥ 4,5); si no —un amarillo, un verde lima—, en casi
 * negro. Si ni así (tonos medios), se oscurece el fondo hasta que el blanco
 * se lea. Nunca sale un monograma ilegible.
 */
export function academyMarkColors(hue: unknown, saturation: unknown): MarkColors {
  const h = validHue(hue) ?? DEFAULT_BRAND_HUE;
  const s = Math.min(100, (validSaturation(saturation) ?? DEFAULT_BRAND_SATURATION) + 2);
  for (let l = 38; l >= 0; l -= 2) {
    const background = hslToHex(h, s, l);
    if (contrastRatio(background, MARK_LIGHT_TEXT) >= MIN_MARK_CONTRAST) {
      return { background, foreground: MARK_LIGHT_TEXT };
    }
    if (contrastRatio(background, MARK_DARK_TEXT) >= MIN_MARK_CONTRAST) {
      return { background, foreground: MARK_DARK_TEXT };
    }
  }
  return { background: '#000000', foreground: MARK_LIGHT_TEXT };
}

/**
 * Símbolo neutro (un birrete) para el aula sin nombre: trazos de 24×24 del set
 * de iconos (Lucide, ISC), en el color de las letras.
 */
export const NEUTRAL_GLYPH_PATHS = [
  'M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z',
  'M22 10v6',
  'M6 12.5V16a6 3 0 0 0 12 0v-3.5',
] as const;

// ── Powered by Didacta ───────────────────────────────────────────────────────

/** Idioma de didacta.io para un tag de idioma (`es-AR` → `es`, `pt-BR` → `pt-br`). */
export function didactaSiteLang(locale: string | null | undefined): 'es' | 'en' | 'pt-br' {
  const base = (locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (base === 'es') return 'es';
  if (base === 'pt') return 'pt-br';
  return 'en';
}

/**
 * Enlace del pie «Powered by Didacta — Crea tu academia gratis»: el alta de
 * didacta.io en el idioma del aula, con la campaña del aula de la que viene
 * (`utm_campaign=<slug>`). Sin slug conocido, sin campaña (nunca inventada).
 */
export function poweredByHref(locale: string | null | undefined, slug?: string | null): string {
  const url = new URL(`https://didacta.io/${didactaSiteLang(locale)}/start`);
  url.searchParams.set('utm_source', 'aula');
  url.searchParams.set('utm_medium', 'powered_by');
  const campaign = slug?.trim();
  if (campaign) url.searchParams.set('utm_campaign', campaign);
  return url.toString();
}

// ── Favicon e imagen para redes ──────────────────────────────────────────────

/** Rutas del web que generan la marca del aula del dominio (ver `app/academy-brand`). */
export const ACADEMY_BRAND_PATH = '/academy-brand';
export const ACADEMY_ICON_PATH = `${ACADEMY_BRAND_PATH}/icon`;
export const ACADEMY_OG_PATH = `${ACADEMY_BRAND_PATH}/og`;

/**
 * ¿Se pueden dibujar estas iniciales con la fuente que lleva el generador de
 * imágenes (Noto Sans, alfabeto latino)? Un nombre en cirílico, griego o CJK
 * se ve bien en la página (fuentes del sistema), pero en el PNG saldría un
 * cuadrado vacío: ahí se usa el símbolo neutro.
 */
export function drawableWithLatinFont(text: string): boolean {
  return /^[\u{20}-\u{24F}\u{1E00}-\u{1EFF}]*$/u.test(text);
}
