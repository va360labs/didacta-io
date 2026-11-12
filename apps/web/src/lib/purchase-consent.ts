/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Casilla de la renuncia al desistimiento, antes de pagar contenido digital.
 *
 * El texto lo da la API (`GET /purchase-consent/withdrawal-waiver`) y es el
 * MISMO que la API guarda como prueba al iniciar el pago: aquí no se escribe
 * ni una palabra de él. La web manda de vuelta la versión que enseñó y el
 * idioma; si el texto cambió entre medias, la API responde 409.
 */

import { apiFetch } from '@/lib/api-client';

export type PurchaseKind = 'course' | 'membership' | 'course_subscription';

export interface WithdrawalWaiverText {
  readonly version: string;
  readonly locale: string;
  /** La frase de la casilla. */
  readonly statement: string;
  /** «Vende: {academia}.» */
  readonly sellerLine: string;
  readonly sellerName: string;
}

/** Lo que viaja con el checkout. */
export interface WithdrawalWaiverAcceptance {
  readonly accepted: true;
  readonly version: string;
  readonly locale: string;
}

export async function getWithdrawalWaiver(
  kind: PurchaseKind,
  locale: string,
): Promise<WithdrawalWaiverText> {
  const query = new URLSearchParams({ kind, locale });
  return apiFetch<WithdrawalWaiverText>(`/api/v1/purchase-consent/withdrawal-waiver?${query}`, {
    method: 'GET',
  });
}

/** `null` mientras la casilla no esté marcada (o el texto no haya cargado). */
export function waiverAcceptance(
  waiver: WithdrawalWaiverText | null,
  checked: boolean,
): WithdrawalWaiverAcceptance | null {
  if (!waiver || !checked) return null;
  return { accepted: true, version: waiver.version, locale: waiver.locale };
}
