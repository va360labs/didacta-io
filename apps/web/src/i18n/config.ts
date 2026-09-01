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
 * mensajes son tres (`es`, `en`, `id`): es-AR comparte el catálogo español y
 * únicamente cambia el formato de fechas/números.
 *
 * Esta lista es la ÚNICA fuente de verdad del idioma elegible: `LOCALE_OPTIONS`
 * (apps/web/src/lib/me.ts) se deriva de ella y `ALLOWED_LOCALES`
 * (apps/api/src/auth/me.controller.ts) la refleja. Antes eran tres listas
 * independientes y por eso `pt-BR` llegó a estar en el selector y en la API sin
 * existir en los catálogos: el usuario elegía portugués, la API lo guardaba,
 * `/cuenta` le confirmaba «Português (Brasil)» y la UI seguía en español.
 *
 * `toSupportedLocale()` sigue degradando cualquier tag ajeno —`pt-BR` incluido—
 * porque en base de datos quedan valores que la UI ya no ofrece: perfiles
 * guardados antes de esta retirada y los que entran por SCIM
 * (apps/api/src/scim/scim.mapper.ts, que copia el locale del IdP sin validar).
 */

export const LOCALE_COOKIE = 'didacta_locale';

export const SUPPORTED_LOCALES = ['es-ES', 'es-AR', 'en-US', 'id-ID'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'es-ES';

/** Normaliza cualquier valor externo (cookie, user.locale) a un tag soportado. */
export function toSupportedLocale(raw: string | null | undefined): SupportedLocale {
  if (!raw) return DEFAULT_LOCALE;
  if ((SUPPORTED_LOCALES as readonly string[]).includes(raw)) return raw as SupportedLocale;
  const base = raw.toLowerCase().split('-')[0];
  if (base === 'es') return 'es-ES';
  if (base === 'en') return 'en-US';
  if (base === 'id') return 'id-ID';
  return DEFAULT_LOCALE;
}

/** Catálogo de mensajes que corresponde a un tag soportado. */
export function catalogOf(locale: SupportedLocale): 'es' | 'en' | 'id' {
  if (locale.startsWith('en')) return 'en';
  if (locale.startsWith('id')) return 'id';
  return 'es';
}
