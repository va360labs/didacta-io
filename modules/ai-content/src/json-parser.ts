/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Parser tolerante para extraer JSON del output de un LLM.
 *
 * El AI Gateway no garantiza que el modelo devuelva JSON puro: a veces
 * envuelve en code fences ```json…``` o añade frases tipo "Aquí tienes el
 * resultado:" antes. Este parser extrae el primer bloque JSON válido,
 * priorizando code fences. Si nada parece JSON, lanza.
 *
 * Solo lo usa el service para parsear respuestas IA — no es API pública.
 */

import { InvalidContentJsonError } from './errors.js';

const CODE_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;
const FALLBACK_OBJECT_RE = /\{[\s\S]*\}/;

export function parseModelJson<T>(raw: string, type: string): T {
  const text = raw.trim();

  // Caso 1: code fence explícito.
  const fenceMatch = CODE_FENCE_RE.exec(text);
  if (fenceMatch && fenceMatch[1]) {
    return parse<T>(fenceMatch[1].trim(), type);
  }

  // Caso 2: respuesta directa.
  if (text.startsWith('{')) {
    return parse<T>(text, type);
  }

  // Caso 3: extraer el primer objeto encontrado en el output.
  const objMatch = FALLBACK_OBJECT_RE.exec(text);
  if (objMatch) {
    return parse<T>(objMatch[0], type);
  }

  throw new InvalidContentJsonError(type, 'no se encontró objeto JSON en la respuesta IA');
}

function parse<T>(json: string, type: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new InvalidContentJsonError(type, (err as Error).message);
  }
}
