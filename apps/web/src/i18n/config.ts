/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Configuración de i18n compartida entre server y client (sin `next/headers`:
 * este fichero tiene que poder importarse desde client components y tests).
 *
 * Modelo de idioma (sin prefijo de URL, decisión D1):
 *   cookie `didacta_locale` → user.locale (la sincroniza LocaleSync) → es-ES.
 *
 * `SUPPORTED_LOCALES` son los tags que la UI puede ACTIVAR; los catálogos de
 * mensajes son solo dos (`es`, `en`): es-AR comparte el catálogo español y
 * únicamente cambia el formato de fechas/números. `pt-BR` sigue siendo válido
 * en el backend (ALLOWED_LOCALES de me.controller) pero cae al catálogo `es`
 * hasta que exista traducción portuguesa.
 */

export const LOCALE_COOKIE = 'didacta_locale';

export const SUPPORTED_LOCALES = ['es-ES', 'es-AR', 'en-US'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'es-ES';

/** Normaliza cualquier valor externo (cookie, user.locale) a un tag soportado. */
export function toSupportedLocale(raw: string | null | undefined): SupportedLocale {
  if (!raw) return DEFAULT_LOCALE;
  if ((SUPPORTED_LOCALES as readonly string[]).includes(raw)) return raw as SupportedLocale;
  const base = raw.toLowerCase().split('-')[0];
  if (base === 'es') return 'es-ES';
  if (base === 'en') return 'en-US';
  return DEFAULT_LOCALE;
}

/** Catálogo de mensajes que corresponde a un tag soportado. */
export function catalogOf(locale: SupportedLocale): 'es' | 'en' {
  return locale.startsWith('en') ? 'en' : 'es';
}
