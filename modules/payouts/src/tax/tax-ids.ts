/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Identificadores fiscales del creador: formato del NIF español (DNI, NIE y
 * NIF de persona jurídica, con su dígito de control) y forma del NIF-IVA de
 * la UE (prefijo VIES del país + número). Puro: sin red ni base.
 *
 * Lo que aquí se valida es la FORMA. Si un NIF-IVA existe de verdad lo dice
 * VIES (`vies.ts`); el NIF español no tiene un servicio público equivalente,
 * y por eso se exige su dígito de control.
 */

/** Estados miembros de la UE → prefijo del NIF-IVA en VIES (Grecia es `EL`). */
export const EU_VAT_PREFIX_BY_COUNTRY: Readonly<Record<string, string>> = {
  AT: 'AT',
  BE: 'BE',
  BG: 'BG',
  CY: 'CY',
  CZ: 'CZ',
  DE: 'DE',
  DK: 'DK',
  EE: 'EE',
  ES: 'ES',
  FI: 'FI',
  FR: 'FR',
  GR: 'EL',
  HR: 'HR',
  HU: 'HU',
  IE: 'IE',
  IT: 'IT',
  LT: 'LT',
  LU: 'LU',
  LV: 'LV',
  MT: 'MT',
  NL: 'NL',
  PL: 'PL',
  PT: 'PT',
  RO: 'RO',
  SE: 'SE',
  SI: 'SI',
  SK: 'SK',
};

/** ¿País de la UE (a efectos de IVA)? Noruega, Liechtenstein, Suiza o Reino Unido, no. */
export function isEuVatCountry(country: string): boolean {
  return Object.prototype.hasOwnProperty.call(EU_VAT_PREFIX_BY_COUNTRY, country.toUpperCase());
}

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Mayúsculas y sin espacios, puntos ni guiones. */
export function compactTaxId(value: string): string {
  return value.toUpperCase().replace(/[\s.\-/]/g, '');
}

export type SpanishNifKind = 'dni' | 'nie' | 'company';

export type SpanishNifCheck =
  | { readonly ok: true; readonly kind: SpanishNifKind; readonly value: string }
  | { readonly ok: false; readonly reason: 'format' | 'check_digit' };

/**
 * NIF español: DNI (8 cifras + letra), NIE (X/Y/Z + 7 cifras + letra) o NIF
 * de persona jurídica (letra + 7 cifras + control, cifra o letra según el
 * tipo de entidad). Comprueba el dígito de control.
 */
export function checkSpanishNif(raw: string): SpanishNifCheck {
  const value = compactTaxId(raw).replace(/^ES/, '');
  if (/^\d{8}[A-Z]$/.test(value)) {
    const expected = DNI_LETTERS[Number(value.slice(0, 8)) % 23];
    return expected === value[8]
      ? { ok: true, kind: 'dni', value }
      : { ok: false, reason: 'check_digit' };
  }
  if (/^[XYZ]\d{7}[A-Z]$/.test(value)) {
    const prefix = String('XYZ'.indexOf(value[0]!));
    const expected = DNI_LETTERS[Number(prefix + value.slice(1, 8)) % 23];
    return expected === value[8]
      ? { ok: true, kind: 'nie', value }
      : { ok: false, reason: 'check_digit' };
  }
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(value)) {
    const digits = value.slice(1, 8);
    let even = 0;
    let odd = 0;
    for (let i = 0; i < 7; i += 1) {
      const d = Number(digits[i]);
      if (i % 2 === 1) even += d;
      else {
        const doubled = d * 2;
        odd += Math.floor(doubled / 10) + (doubled % 10);
      }
    }
    const control = (10 - ((even + odd) % 10)) % 10;
    const controlLetter = 'JABCDEFGHI'[control]!;
    const last = value[8]!;
    const first = value[0]!;
    // Letra obligatoria: entidades sin personalidad, públicas, extranjeras…
    // Cifra obligatoria: sociedades anónimas, limitadas, UTE…
    const mustBeLetter = 'KPQRSNW'.includes(first);
    const mustBeDigit = 'ABEH'.includes(first);
    const okDigit = last === String(control);
    const okLetter = last === controlLetter;
    const ok = mustBeLetter ? okLetter : mustBeDigit ? okDigit : okDigit || okLetter;
    return ok ? { ok: true, kind: 'company', value } : { ok: false, reason: 'check_digit' };
  }
  return { ok: false, reason: 'format' };
}

export type TaxIdCheck =
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      readonly reason: 'required' | 'format' | 'check_digit' | 'entity_mismatch';
    };

/**
 * NIF del creador según su país y su tipo. En España, el formato oficial con
 * control (y una empresa no puede dar un DNI, ni un particular un NIF de
 * sociedad). Fuera, de 2 a 30 caracteres alfanuméricos: cada país tiene el
 * suyo y aquí no se pretende validarlos todos.
 */
export function checkTaxId(
  country: string,
  entityType: 'individual' | 'company',
  raw: string | null | undefined,
): TaxIdCheck {
  const value = compactTaxId(raw ?? '');
  if (!value) return { ok: false, reason: 'required' };
  if (country.toUpperCase() === 'ES') {
    const nif = checkSpanishNif(value);
    if (!nif.ok) return nif;
    if (entityType === 'company' && nif.kind !== 'company') {
      return { ok: false, reason: 'entity_mismatch' };
    }
    if (entityType === 'individual' && nif.kind === 'company') {
      return { ok: false, reason: 'entity_mismatch' };
    }
    return { ok: true, value: nif.value };
  }
  if (!/^[A-Z0-9]{2,30}$/.test(value)) return { ok: false, reason: 'format' };
  return { ok: true, value };
}

export type VatIdCheck =
  | {
      readonly ok: true;
      /** Prefijo VIES (`ES`, `DE`, `EL`…). */
      readonly prefix: string;
      /** Número sin prefijo, tal como lo pide VIES. */
      readonly number: string;
      /** Prefijo + número: `ESB24805335`. */
      readonly value: string;
    }
  | { readonly ok: false; readonly reason: 'not_eu' | 'format' | 'country_mismatch' };

/**
 * NIF-IVA de la UE del país del creador. Acepta el número con o sin prefijo
 * (si falta, se pone el del país). En España además ha de ser un NIF válido.
 */
export function checkVatId(country: string, raw: string): VatIdCheck {
  const upperCountry = country.toUpperCase();
  const prefix = EU_VAT_PREFIX_BY_COUNTRY[upperCountry];
  if (!prefix) return { ok: false, reason: 'not_eu' };
  let value = compactTaxId(raw);
  const given = /^[A-Z]{2}/.exec(value)?.[0];
  // Se acepta el prefijo VIES (`EL`) y también el código ISO del país (`GR`).
  const knownPrefixes = new Set([
    ...Object.keys(EU_VAT_PREFIX_BY_COUNTRY),
    ...Object.values(EU_VAT_PREFIX_BY_COUNTRY),
  ]);
  if (given && knownPrefixes.has(given)) {
    if (given !== prefix && given !== upperCountry)
      return { ok: false, reason: 'country_mismatch' };
    value = value.slice(2);
  }
  if (!/^[A-Z0-9]{2,13}$/.test(value)) return { ok: false, reason: 'format' };
  if (upperCountry === 'ES' && !checkSpanishNif(value).ok) return { ok: false, reason: 'format' };
  return { ok: true, prefix, number: value, value: `${prefix}${value}` };
}

/** «•••• 678Z»: los 4 últimos, nunca el número entero fuera del bloque cifrado. */
export function taxIdHint(value: string): string {
  const compact = compactTaxId(value);
  return compact.length <= 4 ? compact : compact.slice(-4);
}
