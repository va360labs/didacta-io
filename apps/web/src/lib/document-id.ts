/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Validador de DNI/NIE español para validación INLINE en los formularios de
 * perfil (onboarding y /cuenta). Espejo exacto de
 * `apps/api/src/auth/document-id.ts`, que es quien tiene la última palabra en
 * `PATCH /me` — aquí solo adelantamos el error al campo para que el usuario no
 * descubra el problema al final del asistente (issue #59). Si cambia el de la
 * API, cambiar este a la par (los tests de ambos lados fijan el contrato).
 *
 * Checksum oficial: letra esperada = LETTERS[numero mod 23]; el NIE sustituye
 * la letra inicial X→0, Y→1, Z→2 antes de calcular.
 */

const CHECKSUM_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
const NIE_PREFIX_MAP: Record<string, string> = { X: '0', Y: '1', Z: '2' };

const DNI_RE = /^\d{8}[A-Z]$/;
const NIE_RE = /^[XYZ]\d{7}[A-Z]$/;

export function normalizeDocumentId(input: string): string {
  return input.replace(/[\s.-]/g, '').toUpperCase();
}

/**
 * Devuelve true si `value` (ya normalizado) es un DNI o NIE válido,
 * incluyendo el dígito de control.
 */
export function isValidDocumentId(value: string): boolean {
  if (!DNI_RE.test(value) && !NIE_RE.test(value)) return false;
  const head = value.slice(0, value.length - 1);
  const letter = value.charAt(value.length - 1);
  const digits = NIE_RE.test(value) ? NIE_PREFIX_MAP[head.charAt(0)]! + head.slice(1) : head;
  const expected = CHECKSUM_LETTERS.charAt(Number(digits) % 23);
  return letter === expected;
}

/**
 * Azúcar para los formularios: un campo OPCIONAL es válido si está vacío o si,
 * una vez normalizado, pasa el checksum. Centraliza el criterio para que
 * onboarding y /cuenta no lo dupliquen.
 */
export function isDocumentFieldValid(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed === '' || isValidDocumentId(normalizeDocumentId(trimmed));
}

/**
 * ¿Se pide el DNI/NIE en el alta? Es un documento ESPAÑOL (solo sirve para
 * pedir facturas en España): a quien usa la interfaz en otro idioma se le
 * ahorra un campo que no le aplica. Sigue disponible en /cuenta.
 */
export function asksSpanishDocument(uiLocale: string): boolean {
  return uiLocale.toLowerCase().startsWith('es');
}
