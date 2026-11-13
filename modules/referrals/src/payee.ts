/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Datos para cobrar lo ganado EN DINERO: nombre completo, identificador fiscal
 * (NIF/NIE en España, el del país en el resto) y cuenta (IBAN). Validación
 * básica de formato, sin llamadas externas. Para el descuento en la cuota no
 * se pide nada.
 *
 * Son datos personales: se guardan cifrados (`ReferralsCipher`) y nunca se
 * escriben en logs ni en eventos. El creador ve solo lo necesario para pagar
 * (nombre, identificador e IBAN); el alumno los ve enmascarados.
 */

export interface PayeeDetails {
  fullName: string;
  /** País del identificador fiscal y de la cuenta (ISO 3166-1 alfa-2). */
  country: string;
  taxId: string;
  iban: string;
}

export type PayeeField = 'fullName' | 'country' | 'taxId' | 'iban';

export class PayeeValidationError extends Error {
  constructor(readonly fields: PayeeField[]) {
    // Sin los valores: el mensaje puede acabar en un log.
    super(`Datos de cobro no válidos: ${fields.join(', ')}`);
    this.name = 'PayeeValidationError';
  }
}

/** Longitud del IBAN por país (ISO 13616), para los países donde se cobra. */
const IBAN_LENGTH: Readonly<Record<string, number>> = {
  AD: 24,
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GI: 23,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
};

const NIF_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Sin espacios ni guiones, en mayúsculas. */
function compact(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase();
}

/** IBAN con su dígito de control (mod 97) y la longitud de su país. */
export function isValidIban(raw: string): boolean {
  const iban = compact(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) return false;
  const expected = IBAN_LENGTH[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** NIF (8 cifras + letra) o NIE (X/Y/Z + 7 cifras + letra), con su letra de control. */
export function isValidSpanishTaxId(raw: string): boolean {
  const id = compact(raw);
  const nif = /^(\d{8})([A-Z])$/.exec(id);
  if (nif) return NIF_LETTERS[Number(nif[1]) % 23] === nif[2];
  const nie = /^([XYZ])(\d{7})([A-Z])$/.exec(id);
  if (nie) {
    const prefix = { X: '0', Y: '1', Z: '2' }[nie[1] as 'X' | 'Y' | 'Z'];
    return NIF_LETTERS[Number(prefix + nie[2]) % 23] === nie[3];
  }
  return false;
}

/** Valida y normaliza. Lanza `PayeeValidationError` con los campos que fallan. */
export function normalizePayee(input: PayeeDetails): PayeeDetails {
  const fullName = input.fullName.trim().replace(/\s+/g, ' ');
  const country = input.country.trim().toUpperCase();
  const taxId = compact(input.taxId);
  const iban = compact(input.iban);
  const bad: PayeeField[] = [];
  // Nombre y apellidos: al menos dos palabras.
  if (fullName.length < 3 || fullName.length > 120 || fullName.split(' ').length < 2) {
    bad.push('fullName');
  }
  if (!/^[A-Z]{2}$/.test(country)) bad.push('country');
  const taxOk = country === 'ES' ? isValidSpanishTaxId(taxId) : /^[A-Z0-9]{4,20}$/.test(taxId);
  if (!taxOk) bad.push('taxId');
  if (!isValidIban(iban)) bad.push('iban');
  if (bad.length > 0) throw new PayeeValidationError(bad);
  return { fullName, country, taxId, iban };
}

/** «ES12 …» → «ES•• •••• •••• •••• •••• 1234»: lo que el alumno ve de su cuenta. */
export function maskIban(iban: string): string {
  const c = compact(iban);
  return `${c.slice(0, 2)}•• •••• ${c.slice(-4)}`;
}

/** «12345678Z» → «•••••678Z». */
export function maskTaxId(taxId: string): string {
  const c = compact(taxId);
  return `${'•'.repeat(Math.max(0, c.length - 4))}${c.slice(-4)}`;
}

/** IBAN en grupos de 4 para leerlo al hacer la transferencia. */
export function formatIban(iban: string): string {
  return compact(iban)
    .replace(/(.{4})/g, '$1 ')
    .trim();
}
