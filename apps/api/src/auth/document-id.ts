/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Validador de DNI/NIE español. Lo usamos al editar el perfil del usuario
 * porque Fundae requiere identificar a cada participante por su número
 * legal de identidad. La función de checksum es la oficial:
 * letra esperada = LETTERS[numero mod 23], donde NIE substituye la letra
 * inicial X→0, Y→1, Z→2 antes de calcular.
 *
 * Aceptamos sólo formato canónico (mayúsculas, sin separadores). El
 * normalizador `normalizeDocumentId` convierte input del usuario antes de
 * validar para no rechazar variantes razonables ("12.345.678-z").
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
