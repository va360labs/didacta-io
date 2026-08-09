/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Traducción de errores de la API por `code` estable (decisión D6: el backend
 * NO traduce; añade `code` y el front resuelve contra el namespace `errors`).
 *
 * Patrón de uso en catch:
 *   const tErrors = useTranslations('errors');
 *   setError(apiErrorMessage(err, tErrors));
 */

import { ApiHttpError } from '@/lib/api-client';
import type { TranslatorLike } from './labels';

/**
 * Codes cuyo mensaje de catálogo interpola `{detail}` con el diagnóstico crudo
 * de un sistema externo que el backend manda en `ApiError.detail`.
 *
 * La lista es EXPLÍCITA y corta a propósito: es el contrato entre el body de la
 * API y las DOS traducciones. Añadir un code aquí obliga a que el catálogo `es`
 * y el `en` tengan la key con `{detail}` (hay test), y a que el throw del
 * backend rellene el campo. Sin la lista habría que adivinar en runtime si un
 * mensaje lleva placeholder, y un `t(code)` sobre un mensaje con `{detail}` sin
 * valor pinta la key cruda en pantalla.
 */
const CODES_WITH_DETAIL: ReadonlySet<string> = new Set([
  'ADMIN_STRIPE_KEY_REJECTED',
  'ADMIN_SMTP_TEST_FAILED',
]);

/**
 * Si el backend mandó `code` y existe `errors.<code>` en el catálogo →
 * mensaje traducido. Si no → `e.message` (el español del backend como
 * fallback honesto: nunca una key cruda ni un texto inventado en pantalla).
 *
 * CAMINO DEGRADADO ÚNICO: un code de `CODES_WITH_DETAIL` que llega SIN
 * `detail` (API vieja contra un front nuevo, o un throw que se olvidó del
 * campo). Se devuelve `e.message`, que lleva el diagnóstico incrustado en
 * español, en vez de pintar la frase traducida con el hueco vacío: preferimos
 * el idioma equivocado a prometer un diagnóstico y no enseñarlo.
 */
export function apiErrorMessage(e: unknown, t: TranslatorLike): string {
  if (e instanceof ApiHttpError) {
    // Un code con '.' se interpretaría como path de namespace: se ignora.
    if (e.code && !e.code.includes('.') && t.has(e.code)) {
      if (!CODES_WITH_DETAIL.has(e.code)) return t(e.code);
      const detail = typeof e.detail === 'string' ? e.detail.trim() : '';
      if (!detail) return e.message;
      return t(e.code, { detail });
    }
    return e.message;
  }
  // Fallos de red de fetch (API caída, sin conexión) son TypeError con
  // mensajes de motor ("Failed to fetch", "Load failed"), y un proxy que
  // devuelve HTML rompe JSON.parse con SyntaxError. Ninguno debe llegar a
  // pantalla. Los `Error` normales sí conservan su message: hay throws
  // intencionales con copy propio en libs y componentes.
  if (e instanceof TypeError || e instanceof SyntaxError) return t('unknown');
  if (e instanceof Error && e.message) return e.message;
  return t('unknown');
}
