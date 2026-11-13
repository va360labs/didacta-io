/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { isEuVatCountry } from '../tax/tax-ids.js';
import type { VatStatus } from '../tax/tax-profile.service.js';

/**
 * IVA de la comisión del operador. La comisión (el 5 %) lleva los impuestos
 * INCLUIDOS: el creador paga el 5 % y nada más, esté donde esté (condiciones,
 * apartado 4). Lo que cambia según dónde está es cómo se desglosa:
 *
 * | Creador | Régimen | Desglose |
 * |---|---|---|
 * | España (península y Baleares) | `ES_VAT` | base = comisión ÷ 1,21; IVA 21 % |
 * | Canarias, Ceuta o Melilla | `NOT_SUBJECT_ES_SPECIAL_TERRITORY` | sin IVA (fuera del territorio de aplicación, arts. 3 y 69 LIVA) |
 * | Otro país de la UE con NIF-IVA válido en VIES | `EU_REVERSE_CHARGE` | sin IVA; inversión del sujeto pasivo (art. 196 Directiva 2006/112/CE) |
 * | Otro país de la UE sin NIF-IVA válido | `ES_VAT_EU_NO_VAT_ID` | IVA español del 21 % incluido (prudente) |
 * | Fuera de la UE | `NOT_SUBJECT_OUTSIDE_EU` | no sujeta (art. 69.Uno.1.º LIVA) |
 *
 * El caso «UE sin NIF-IVA válido» es el único dudoso: sin la validación no se
 * puede aplicar la inversión del sujeto pasivo (art. 18 del Reglamento de
 * Ejecución 282/2011), y se cobra el IVA español como si fuera en España. Si
 * más tarde VIES confirma el número, la factura se sustituye por una
 * rectificativa sin IVA. [VERIFICAR con el asesor: si a un empresario de la UE
 * sin NIF-IVA debe aplicársele la regla de consumidor final, con IVA del país
 * del creador vía OSS.]
 */

export type VatRegime =
  | 'ES_VAT'
  | 'EU_REVERSE_CHARGE'
  | 'ES_VAT_EU_NO_VAT_ID'
  | 'NOT_SUBJECT_OUTSIDE_EU'
  | 'NOT_SUBJECT_ES_SPECIAL_TERRITORY';

/** Tipo general del IVA en España, en puntos básicos. */
export const ES_VAT_RATE_BPS = 2100;

/** Territorios españoles fuera del IVA, por el prefijo del código postal. */
const ES_SPECIAL_TERRITORY_PREFIX: Readonly<Record<string, string>> = {
  '35': 'Canarias',
  '38': 'Canarias',
  '51': 'Ceuta',
  '52': 'Melilla',
};

export function spanishSpecialTerritory(postalCode: string | null | undefined): string | null {
  const code = (postalCode ?? '').trim();
  if (!/^\d{5}$/.test(code)) return null;
  return ES_SPECIAL_TERRITORY_PREFIX[code.slice(0, 2)] ?? null;
}

export function vatRegimeFor(input: {
  readonly country: string;
  readonly postalCode?: string | null;
  readonly vatStatus: VatStatus;
}): VatRegime {
  const country = input.country.toUpperCase();
  if (country === 'ES') {
    return spanishSpecialTerritory(input.postalCode)
      ? 'NOT_SUBJECT_ES_SPECIAL_TERRITORY'
      : 'ES_VAT';
  }
  if (isEuVatCountry(country)) {
    return input.vatStatus === 'valid' ? 'EU_REVERSE_CHARGE' : 'ES_VAT_EU_NO_VAT_ID';
  }
  return 'NOT_SUBJECT_OUTSIDE_EU';
}

export function vatRateBpsFor(regime: VatRegime): number {
  return regime === 'ES_VAT' || regime === 'ES_VAT_EU_NO_VAT_ID' ? ES_VAT_RATE_BPS : 0;
}

/**
 * Desglosa un total CON IVA incluido. `base = total ÷ (1 + tipo)` redondeado
 * al céntimo (las mitades, hacia fuera de cero) y `cuota = total − base`, así
 * que base + cuota es SIEMPRE el total exacto. Con signo: una rectificativa
 * negativa se desglosa igual que la positiva, con el signo cambiado.
 */
export function splitVatIncluded(
  total: number,
  vatRateBps: number,
): { readonly taxBase: number; readonly vatAmount: number } {
  if (!Number.isSafeInteger(total)) throw new RangeError(`total no entero: ${total}`);
  if (!Number.isInteger(vatRateBps) || vatRateBps < 0) {
    throw new RangeError(`tipo no válido: ${vatRateBps}`);
  }
  if (vatRateBps === 0 || total === 0) return { taxBase: total || 0, vatAmount: 0 };
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const denominator = 10_000 + vatRateBps;
  // round_half_up(abs × 10000 / denominator) en enteros.
  const base = Math.floor((2 * abs * 10_000 + denominator) / (2 * denominator));
  // `|| 0`: nunca un −0 (se vería «-0,00» en la factura).
  return { taxBase: sign * base || 0, vatAmount: sign * (abs - base) || 0 };
}

/** Mención legal de cada régimen (en la factura, en español; la web traduce). */
export function regimeMention(regime: VatRegime, territory?: string | null): string | null {
  switch (regime) {
    case 'EU_REVERSE_CHARGE':
      return 'Operación no sujeta al IVA español (art. 69.Uno.1.º de la Ley 37/1992). Inversión del sujeto pasivo: art. 196 de la Directiva 2006/112/CE.';
    case 'NOT_SUBJECT_OUTSIDE_EU':
      return 'Operación no sujeta al IVA español: servicio prestado a un empresario o profesional establecido fuera de la Unión Europea (art. 69.Uno.1.º de la Ley 37/1992).';
    case 'NOT_SUBJECT_ES_SPECIAL_TERRITORY':
      return `Operación no sujeta al IVA: destinatario establecido en ${territory ?? 'Canarias, Ceuta o Melilla'}, fuera del territorio de aplicación del impuesto (arts. 3 y 69.Uno.1.º de la Ley 37/1992).`;
    case 'ES_VAT_EU_NO_VAT_ID':
      return 'IVA español aplicado: el destinatario no ha acreditado un NIF-IVA válido en VIES.';
    case 'ES_VAT':
    default:
      return null;
  }
}
