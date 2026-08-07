/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Helpers de formateo para presentación. Vive en `apps/web/src/lib` porque
 * son puramente del lado cliente (UI). El backend devuelve datos crudos
 * (minutos enteros, fechas ISO, etc.) y la web los humaniza acá.
 */

/**
 * Formatea una duración en minutos a un string legible en castellano.
 *
 * @deprecated Usa `formatDuration(minutes, t)` de `@/lib/i18n/format` con
 * `t = useTranslations('common')` — versión locale-aware con ICU. Esta se
 * elimina cuando la última unidad de migración i18n deje de importarla.
 *
 * Reglas:
 *  - `null` o `undefined` → `null` (el caller decide si mostrar nada).
 *  - 0 → `'0 min'`.
 *  - < 60 min → `'X min'` (45 min).
 *  - múltiplo exacto de 60 → `'X h'` (2 h, 50 h).
 *  - mixto → `'X h Y min'` (1 h 30 min).
 *
 * Ejemplos:
 *  - `formatDuration(45)` → `'45 min'`
 *  - `formatDuration(60)` → `'1 h'`
 *  - `formatDuration(90)` → `'1 h 30 min'`
 *  - `formatDuration(3000)` → `'50 h'` (caso del feedback)
 *  - `formatDuration(null)` → `null`
 */
export function formatDuration(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null;
  if (!Number.isFinite(minutes) || minutes < 0) return null;

  const totalMinutes = Math.floor(minutes);
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const hours = Math.floor(totalMinutes / 60);
  const remaining = totalMinutes % 60;
  if (remaining === 0) return `${hours} h`;
  return `${hours} h ${remaining} min`;
}
