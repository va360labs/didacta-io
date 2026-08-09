/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Forma mínima del `t` de next-intl que aceptan los helpers de esta carpeta.
 *
 * El `t` real está tipado contra las keys del catálogo (augment en
 * `i18n/types.d.ts`), así que un parámetro `(key: string) => string` NO lo
 * aceptaría. La call signature usa `any` y `has` va en sintaxis de MÉTODO
 * (bivariante en strict mode) justo para que el `t` real sea asignable sin
 * casts en los call-sites.
 */
export interface TranslatorLike {
  // `key` y `values` van como `any` a propósito: el Translator real tipa
  // ambos condicionalmente por key del catálogo (con overloads), y cualquier
  // tipo más estricto aquí rompe la asignabilidad estructural.
  // eslint-disable-next-line no-unused-vars
  (key: any, values?: any): string;
  // eslint-disable-next-line no-unused-vars
  has(key: string): boolean;
}

/**
 * Lookup con fallback para diccionarios de clave ABIERTA (strings arbitrarios:
 * estados de un proveedor externo, labels de módulos third-party). Si la key
 * no está en el catálogo, se muestra el valor crudo — nunca una key en
 * pantalla.
 *
 * Para enums TS cerrados NO uses esto: `t(\`userStatus.${value}\`)` directo,
 * que el template literal type ya garantiza la key en compile-time.
 */
export function labelOr(t: TranslatorLike, key: string, fallback: string): string {
  return t.has(key) ? t(key) : fallback;
}

/** Forma mínima del `t` con `markup` que aceptan los helpers de esta carpeta. */
export interface MarkupTranslatorLike {
  // eslint-disable-next-line no-unused-vars
  markup(key: any, values?: any): string;
}

/**
 * `t.markup` con degradado explícito para copy DECORATIVO (placeholders,
 * ejemplos): si el mensaje del catálogo trae una etiqueta que el call-site no
 * declara, o el markup está mal cerrado, `use-intl` NO lanza — llama a `onError`
 * y devuelve `getMessageFallback`, que sin override es la RUTA DE LA KEY. O sea:
 * el usuario ve `adminMarca.branding.footerPlaceholder` en pantalla, el mismo
 * síntoma que arregla `labelOr` para los enums abiertos.
 *
 * `fallback` se pinta si el resultado contiene la key (señal inequívoca de que
 * `use-intl` degradó) o si algo lanza de verdad.
 */
export function markupOr(
  t: MarkupTranslatorLike,
  key: string,
  values: Record<string, (chunks: string) => string>,
  fallback: string,
): string {
  try {
    const result = t.markup(key, values);
    return result.includes(key) ? fallback : result;
  } catch {
    return fallback;
  }
}
