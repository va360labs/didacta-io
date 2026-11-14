/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { labelOr, type TranslatorLike } from './labels';

/**
 * Sufijo de periodicidad de un precio recurrente («/mes», «/month», «/mês»).
 *
 * Las suscripciones que se leen de Stripe, PayPal o WooCommerce traen el
 * intervalo en inglés (`month`, `year`…) y se pintaba tal cual: un panel en
 * español decía «19,00 €/month». `t` es el del namespace `common`
 * (`perInterval.*`). Un intervalo que el catálogo no conoce se queda como
 * viene, nunca la key en pantalla; sin intervalo, nada.
 */
export function perIntervalSuffix(t: TranslatorLike, interval: string | null | undefined): string {
  if (!interval) return '';
  return labelOr(t, `perInterval.${interval}`, `/${interval}`);
}
