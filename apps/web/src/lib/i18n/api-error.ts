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
 * Si el backend mandó `code` y existe `errors.<code>` en el catálogo →
 * mensaje traducido. Si no → `e.message` (el español del backend como
 * fallback honesto: nunca una key cruda ni un texto inventado en pantalla).
 */
export function apiErrorMessage(e: unknown, t: TranslatorLike): string {
  if (e instanceof ApiHttpError) {
    // Un code con '.' se interpretaría como path de namespace: se ignora.
    if (e.code && !e.code.includes('.') && t.has(e.code)) return t(e.code);
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
