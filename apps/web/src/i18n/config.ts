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
 * mensajes son tres (`es`, `en`, `pt`): es-AR comparte el catálogo español y
 * únicamente cambia el formato de fechas/números.
 *
 * Esta lista es la ÚNICA fuente de verdad del idioma elegible: `LOCALE_OPTIONS`
 * (apps/web/src/lib/me.ts) se deriva de ella, y `ALLOWED_LOCALES`
 * (apps/api/src/auth/me.controller.ts) y `CHECKOUT_ALLOWED_LOCALES`
 * (apps/api/src/common/checkout-locale.ts) la reflejan. Antes eran listas
 * independientes y por eso `pt-BR` llegó a estar en el selector y en la API sin
 * existir en los catálogos: el usuario elegía portugués, la API lo guardaba,
 * `/account` le confirmaba «Português (Brasil)» y la UI seguía en español. Se
 * retiró entonces y vuelve ahora CON su catálogo (`messages/pt`), que es la
 * condición que faltaba.
 *
 * REGLA para añadir un idioma: primero el catálogo completo (la guarda de
 * `messages-parity.test.ts` no deja entrar uno a medias) y solo después el tag
 * aquí. Un tag en esta lista sin catálogo detrás es exactamente el bug de
 * arriba.
 *
 * `toSupportedLocale()` sigue degradando cualquier tag ajeno porque en base de
 * datos puede haber valores que la UI no ofrece: los que entran por SCIM
 * (apps/api/src/scim/scim.mapper.ts copia el locale del IdP sin validar).
 */

export const LOCALE_COOKIE = 'didacta_locale';

export const SUPPORTED_LOCALES = ['es-ES', 'es-AR', 'en-US', 'pt-BR'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'es-ES';

/** Catálogos de mensajes que existen en `messages/<catálogo>/`. */
export const MESSAGE_CATALOGS = ['es', 'en', 'pt'] as const;
export type MessageCatalog = (typeof MESSAGE_CATALOGS)[number];

/**
 * Normaliza cualquier valor externo (cookie, user.locale) a un tag soportado.
 *
 * Un idioma sin región (`pt`) o con una región que el producto no distingue
 * (`pt-PT`, `en-GB`) cae a la variante canónica de su idioma base. El portugués
 * europeo cae a `pt-BR` a propósito: comparte catálogo, y servirle español a un
 * lusófono teniendo portugués sería peor.
 */
export function toSupportedLocale(raw: string | null | undefined): SupportedLocale {
  if (!raw) return DEFAULT_LOCALE;
  if ((SUPPORTED_LOCALES as readonly string[]).includes(raw)) return raw as SupportedLocale;
  const base = raw.toLowerCase().split('-')[0];
  if (base === 'es') return 'es-ES';
  if (base === 'en') return 'en-US';
  if (base === 'pt') return 'pt-BR';
  return DEFAULT_LOCALE;
}

/** Catálogo de mensajes que corresponde a un tag soportado. */
export function catalogOf(locale: SupportedLocale): MessageCatalog {
  if (locale.startsWith('en')) return 'en';
  if (locale.startsWith('pt')) return 'pt';
  return 'es';
}

/**
 * Idiomas que puede tener un AULA (`tenant_setting academy/locale` en la API):
 * uno por catálogo. La misma lista está en `ACADEMY_LOCALES` de la API
 * (`apps/api/src/common/academy-defaults.ts`); lo vigila `config.test.ts`.
 * El valor guardado es el código del catálogo (`pt`), no el tag de la interfaz
 * (`pt-BR`): `academyUiLocale` hace la traducción.
 */
export const ACADEMY_LOCALES = ['es', 'en', 'pt'] as const;
export type AcademyLocale = (typeof ACADEMY_LOCALES)[number];

/**
 * Nombre de cada idioma EN ESE IDIOMA (como en cualquier selector de idioma):
 * quien no entiende la interfaz tiene que poder reconocer el suyo.
 */
export const ACADEMY_LOCALE_NAMES: Record<AcademyLocale, string> = {
  es: 'Español',
  en: 'English',
  pt: 'Português (Brasil)',
};

export function isAcademyLocale(raw: unknown): raw is AcademyLocale {
  return typeof raw === 'string' && (ACADEMY_LOCALES as readonly string[]).includes(raw);
}

/** Tag de la interfaz con el que se pinta un aula en ese idioma. */
export function academyUiLocale(locale: AcademyLocale): SupportedLocale {
  if (locale === 'en') return 'en-US';
  if (locale === 'pt') return 'pt-BR';
  return 'es-ES';
}

/** ¿La cookie trae un idioma que la interfaz sabe pintar? (Si no, no cuenta.) */
export function isUsableLocaleCookie(raw: string | null | undefined): boolean {
  if (!raw) return false;
  if ((SUPPORTED_LOCALES as readonly string[]).includes(raw)) return true;
  const base = raw.toLowerCase().split('-')[0];
  return (MESSAGE_CATALOGS as readonly string[]).includes(base ?? '');
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
