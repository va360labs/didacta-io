/**
 * Validación de identificadores fiscales españoles para mod.fundae.
 *
 * Cubre los tres formatos que aparecen como NIF de empresa o de persona
 * en el contexto Fundae:
 *
 *   - DNI (persona física): 8 dígitos + letra de control. Letra calculada
 *     como `LETRAS[numero % 23]` con la cadena oficial T-R-W-A-G-M-Y-F-P-D-X-B-N-J-Z-S-Q-V-H-L-C-K-E.
 *   - NIE (extranjero residente): X|Y|Z + 7 dígitos + letra. Se sustituye
 *     X→0, Y→1, Z→2 y se aplica la misma fórmula del DNI.
 *   - CIF (persona jurídica, formato legacy aún vigente): letra inicial
 *     + 7 dígitos + carácter de control (letra o dígito según la inicial).
 *     Algoritmo: suma de pares + suma de impares (cada cifra impar
 *     duplicada y sumando sus dígitos). El control es `(10 - total % 10)`,
 *     mapeado a letra J-A-B-...-I para letras iniciales que exigen letra
 *     (P, Q, R, S, W, N) o devuelto como dígito para las que aceptan
 *     número (A, B, E, H).
 *
 * El nuevo NIF unificado (Ley 4/2008) tiene la misma estructura que el
 * CIF para personas jurídicas. Aquí lo tratamos bajo el caso CIF.
 */

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

const CIF_PAR_LETTERS_REQUIRED = new Set(['P', 'Q', 'R', 'S', 'W', 'N']);
const CIF_PAR_LETTERS_OPTIONAL = new Set(['A', 'B', 'E', 'H']);
const CIF_PAR_LETTERS_ALL = new Set([
  ...CIF_PAR_LETTERS_REQUIRED,
  ...CIF_PAR_LETTERS_OPTIONAL,
  // Reservadas / poco frecuentes pero válidas: C, D, F, G, J, U, V.
  'C',
  'D',
  'F',
  'G',
  'J',
  'U',
  'V',
]);

/**
 * Normaliza un input "sucio" del usuario al formato canónico que vamos a
 * persistir. Quita espacios, guiones, puntos y pasa a mayúsculas.
 *
 * No valida — sólo limpia. Aplicar siempre antes de comparar contra DB.
 */
export function normalizeSpanishTaxId(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s\-.]+/g, '');
}

export type TaxIdKind = 'DNI' | 'NIE' | 'CIF';

export interface TaxIdValidation {
  ok: boolean;
  kind?: TaxIdKind;
  /** Identificador normalizado si ok. Igual al input limpio si no ok. */
  normalized: string;
  /** Razón legible cuando ok=false. */
  reason?: string;
}

/**
 * Valida un NIF/NIE/CIF español devolviendo el tipo detectado y el valor
 * normalizado. Trata el input como opaco (no lo limpia él mismo); usar
 * `normalizeSpanishTaxId` antes si viene del usuario.
 */
export function validateSpanishTaxId(input: string): TaxIdValidation {
  const value = normalizeSpanishTaxId(input);
  if (value.length === 0) {
    return { ok: false, normalized: value, reason: 'NIF vacío.' };
  }

  // DNI: 8 dígitos + letra
  if (/^\d{8}[A-Z]$/.test(value)) {
    const number = Number.parseInt(value.slice(0, 8), 10);
    const expected = DNI_LETTERS[number % 23];
    if (value[8] !== expected) {
      return {
        ok: false,
        kind: 'DNI',
        normalized: value,
        reason: `Letra de control DNI inválida (esperada ${expected}).`,
      };
    }
    return { ok: true, kind: 'DNI', normalized: value };
  }

  // NIE: X|Y|Z + 7 dígitos + letra
  if (/^[XYZ]\d{7}[A-Z]$/.test(value)) {
    const prefixDigit = { X: '0', Y: '1', Z: '2' }[value[0] as 'X' | 'Y' | 'Z'];
    const number = Number.parseInt(prefixDigit + value.slice(1, 8), 10);
    const expected = DNI_LETTERS[number % 23];
    if (value[8] !== expected) {
      return {
        ok: false,
        kind: 'NIE',
        normalized: value,
        reason: `Letra de control NIE inválida (esperada ${expected}).`,
      };
    }
    return { ok: true, kind: 'NIE', normalized: value };
  }

  // CIF / NIF entidad: letra + 7 dígitos + control (letra o dígito)
  if (/^[A-Z]\d{7}[0-9A-J]$/.test(value)) {
    const initial = value[0]!;
    if (!CIF_PAR_LETTERS_ALL.has(initial)) {
      return {
        ok: false,
        kind: 'CIF',
        normalized: value,
        reason: `Letra inicial "${initial}" no es válida para CIF.`,
      };
    }
    const digits = value.slice(1, 8);
    const provided = value[8]!;

    let sumPair = 0;
    let sumOdd = 0;
    for (let i = 0; i < 7; i += 1) {
      const d = Number.parseInt(digits[i]!, 10);
      if (i % 2 === 0) {
        // Posiciones impares (1ª, 3ª, 5ª, 7ª) según norma → duplicar y sumar dígitos.
        const doubled = d * 2;
        sumOdd += doubled >= 10 ? Math.floor(doubled / 10) + (doubled % 10) : doubled;
      } else {
        sumPair += d;
      }
    }
    const total = sumPair + sumOdd;
    const controlDigit = (10 - (total % 10)) % 10;
    const controlLetter = 'JABCDEFGHI'[controlDigit]!;

    const requiresLetter = CIF_PAR_LETTERS_REQUIRED.has(initial);
    const acceptsDigit = CIF_PAR_LETTERS_OPTIONAL.has(initial);

    if (requiresLetter) {
      if (provided !== controlLetter) {
        return {
          ok: false,
          kind: 'CIF',
          normalized: value,
          reason: `Carácter de control CIF inválido (esperado ${controlLetter}).`,
        };
      }
      return { ok: true, kind: 'CIF', normalized: value };
    }
    if (acceptsDigit) {
      // Para A/B/E/H acepta tanto el dígito como la letra. Algunos
      // organismos emiten una u otra; ambas son legales.
      if (provided !== String(controlDigit) && provided !== controlLetter) {
        return {
          ok: false,
          kind: 'CIF',
          normalized: value,
          reason: `Carácter de control CIF inválido (esperado ${controlDigit} o ${controlLetter}).`,
        };
      }
      return { ok: true, kind: 'CIF', normalized: value };
    }
    // Resto de letras: típicamente cierran con dígito.
    if (provided !== String(controlDigit)) {
      return {
        ok: false,
        kind: 'CIF',
        normalized: value,
        reason: `Dígito de control CIF inválido (esperado ${controlDigit}).`,
      };
    }
    return { ok: true, kind: 'CIF', normalized: value };
  }

  return {
    ok: false,
    normalized: value,
    reason: 'No coincide con ningún formato conocido (DNI, NIE, CIF).',
  };
}

/**
 * Helper booleano para usos donde no necesitamos el detalle (por ejemplo
 * un schema de Zod con `.refine`). Mantén `validateSpanishTaxId` cuando
 * quieras dar feedback al usuario.
 */
export function isValidSpanishTaxId(input: string): boolean {
  return validateSpanishTaxId(input).ok;
}
