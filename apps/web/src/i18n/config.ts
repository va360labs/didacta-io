/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Configuración de i18n compartida entre server y client (sin `next/headers`:
 * este fichero tiene que poder importarse desde client components y tests).
 *
 * Modelo de idioma (sin prefijo de URL, decisión D1):
 *   cookie `didacta_locale` → user.locale (la sincroniza LocaleSync) → idioma
 *   del aula (quien entra sin cookie) → es-ES. Ver `resolveRequestLocale`.
 *
 * `SUPPORTED_LOCALES` son los tags que la UI puede ACTIVAR; los catálogos de
 * mensajes son solo dos (`es`, `en`): es-AR comparte el catálogo español y
 * únicamente cambia el formato de fechas/números.
 *
 * Esta lista es la ÚNICA fuente de verdad del idioma elegible: `LOCALE_OPTIONS`
 * (apps/web/src/lib/me.ts) se deriva de ella y `ALLOWED_LOCALES`
 * (apps/api/src/auth/me.controller.ts) la refleja. Antes eran tres listas
 * independientes y por eso `pt-BR` llegó a estar en el selector y en la API sin
 * existir en los catálogos: el usuario elegía portugués, la API lo guardaba,
 * `/account` le confirmaba «Português (Brasil)» y la UI seguía en español.
 *
 * `toSupportedLocale()` sigue degradando cualquier tag ajeno —`pt-BR` incluido—
 * porque en base de datos quedan valores que la UI ya no ofrece: perfiles
 * guardados antes de esta retirada y los que entran por SCIM
 * (apps/api/src/scim/scim.mapper.ts, que copia el locale del IdP sin validar).
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

/**
 * Idiomas que puede tener un AULA (`tenant_setting academy/locale` en la API):
 * los de los catálogos. Cuando exista el catálogo `pt`, se suma aquí y en
 * `ACADEMY_LOCALES` de la API (`apps/api/src/common/academy-defaults.ts`).
 */
export const ACADEMY_LOCALES = ['es', 'en'] as const;
export type AcademyLocale = (typeof ACADEMY_LOCALES)[number];

/**
 * Nombre de cada idioma EN ESE IDIOMA (como en cualquier selector de idioma):
 * quien no entiende la interfaz tiene que poder reconocer el suyo.
 */
export const ACADEMY_LOCALE_NAMES: Record<AcademyLocale, string> = {
  es: 'Español',
  en: 'English',
};

export function isAcademyLocale(raw: unknown): raw is AcademyLocale {
  return typeof raw === 'string' && (ACADEMY_LOCALES as readonly string[]).includes(raw);
}

/** Tag de la interfaz con el que se pinta un aula en ese idioma. */
export function academyUiLocale(locale: AcademyLocale): SupportedLocale {
  return locale === 'en' ? 'en-US' : 'es-ES';
}

/** ¿La cookie trae un idioma que la interfaz sabe pintar? (Si no, no cuenta.) */
export function isUsableLocaleCookie(raw: string | null | undefined): boolean {
  if (!raw) return false;
  if ((SUPPORTED_LOCALES as readonly string[]).includes(raw)) return true;
  const base = raw.toLowerCase().split('-')[0];
  return base === 'es' || base === 'en';
}

/**
 * Idioma con el que se pinta una petición:
 *   cookie `didacta_locale` (la elección del visitante, o la de su perfil que
 *   escribe LocaleSync) → idioma del AULA (quien entra sin cookie: visitantes
 *   de la venta, el catálogo, /join, el acceso…) → es-ES.
 * Una cookie con un idioma que la interfaz no tiene no cuenta como elección.
 */
export function resolveRequestLocale(
  cookie: string | null | undefined,
  academy: AcademyLocale | null | undefined,
): SupportedLocale {
  if (isUsableLocaleCookie(cookie)) return toSupportedLocale(cookie);
  if (academy) return academyUiLocale(academy);
  return DEFAULT_LOCALE;
}
