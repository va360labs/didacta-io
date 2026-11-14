/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PaymentMode } from '../payment-mode.resolver';

/**
 * ¿Sirve un código de descuento como premio en un aula con este modo de cobro?
 *
 * En el modo plataforma (Didacta Cloud) el checkout va por la cuenta del
 * operador y rechaza los códigos promocionales (`promotionCodes: 'deny'` en
 * `platform-stripe-adapters.ts`), para que un código no valga en todas las
 * aulas: dar uno de premio sería entregar algo que no funciona. Esté o no lista
 * la cuenta conectada, el destino es el mismo. Con claves propias (`own`) el
 * checkout los acepta; sin cobros configurados (`none`) se deja crear, porque
 * el día que conecte sus claves funcionarán.
 */
export function discountCodesAllowedFor(mode: PaymentMode): boolean {
  return mode.mode !== 'platform';
}
