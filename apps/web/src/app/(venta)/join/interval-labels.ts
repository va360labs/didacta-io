/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Etiquetas de periodicidad de /join (catálogo `publicSite`). Las comparten la
 * columna de pago y las tarjetas de nivel, para que un mismo plan se lea igual
 * en las dos.
 */

import type { TranslatorLike } from '@/lib/i18n/labels';

/** Etiqueta de periodicidad: "/mes", "/trimestre", …, "/N meses" (catálogo i18n). */
export function intervalSuffixLabel(t: TranslatorLike, intervalMonths: number): string {
  if (intervalMonths === 12) return t('unete.intervalSuffixYear');
  if (intervalMonths === 6) return t('unete.intervalSuffixSemester');
  if (intervalMonths === 3) return t('unete.intervalSuffixQuarter');
  if (intervalMonths === 1) return t('unete.intervalSuffixMonth');
  return t('unete.intervalSuffixMonths', { months: intervalMonths });
}

/** Nombre largo: "Suscripción mensual/trimestral/…/cada N meses" (catálogo i18n). */
export function intervalDescriptionLabel(t: TranslatorLike, intervalMonths: number): string {
  if (intervalMonths === 12) return t('unete.intervalDescYear');
  if (intervalMonths === 6) return t('unete.intervalDescSemester');
  if (intervalMonths === 3) return t('unete.intervalDescQuarter');
  if (intervalMonths === 1) return t('unete.intervalDescMonth');
  return t('unete.intervalDescMonths', { months: intervalMonths });
}
