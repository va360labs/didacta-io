/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { GraderResponseParseError } from './errors.js';
import type { CriterionScoreView, RubricCriterionDto } from './dto.js';

export interface BuildGraderPromptInput {
  questionPrompt: string;
  studentAnswer: string;
  rubricInstructions: string;
  criteria: RubricCriterionDto[];
  /** Puntos máximos de la pregunta. Debe igualar Σweights de los criterios. */
  maxScore: number;
}

export interface BuiltGraderPrompt {
  system: string;
  user: string;
}

/**
 * Construye el prompt para que el modelo evalúe una respuesta abierta.
 *
 * Estrategia:
 *   - System: rol "evaluador docente" + restricciones de formato JSON
 *     estricto. Sin formato JSON parseable, no podemos persistir nada.
 *   - User: contexto de la pregunta + rúbrica + respuesta del alumno + el
 *     schema JSON exacto que esperamos como salida.
 *
 * El uso de "Responde ÚNICAMENTE con JSON válido" reduce alucinaciones de
 * texto envolvente. Aun así, `parseGraderResponse` extrae el primer bloque
 * JSON balanceado por si algún provider sigue añadiendo prefacios.
 */
export function buildGraderPrompt(input: BuildGraderPromptInput): BuiltGraderPrompt {
  const totalWeight = input.criteria.reduce((acc, c) => acc + c.weight, 0);
  const criteriaList = input.criteria
    .map((c, i) => `${i + 1}. "${c.name}" (peso ${c.weight} ptos)\n   ${c.description}`)
    .join('\n');

  const system =
    'Eres un evaluador docente experto. Tu tarea es corregir la respuesta abierta de un ' +
    'alumno usando una rúbrica con criterios ponderados. ' +
    'Sé justo, específico y constructivo. ' +
    'Responde ÚNICAMENTE con un JSON válido que cumpla el schema indicado, sin texto fuera del JSON, ' +
    'sin Markdown, sin bloques de código, sin comentarios. ' +
    'Si la respuesta del alumno está vacía o es ininteligible, asigna 0 a cada criterio y ' +
    'explica brevemente por qué en cada justificación.';

  const user = [
    `# Pregunta`,
    input.questionPrompt,
    '',
    `# Instrucciones de la rúbrica`,
    input.rubricInstructions,
    '',
    `# Criterios (suma de pesos = ${totalWeight}, máximo de la pregunta = ${input.maxScore})`,
    criteriaList,
    '',
    `# Respuesta del alumno`,
    input.studentAnswer.trim().length === 0 ? '(respuesta vacía)' : input.studentAnswer.trim(),
    '',
    `# Formato de salida JSON estricto`,
    '{',
    '  "perCriterion": [',
    '    { "name": "<nombre exacto del criterio>", "score": <int 0..peso>, "justification": "<1-2 frases>" }',
    '  ],',
    '  "overallFeedback": "<feedback global para el alumno, 2-4 frases, tono constructivo>"',
    '}',
    '',
    `# Reglas`,
    `- Devuelve un objeto por cada criterio listado arriba, en el mismo orden.`,
    `- "name" debe coincidir EXACTAMENTE con el nombre del criterio.`,
    `- "score" es entero entre 0 y el peso del criterio (no excedas el peso).`,
    `- "overallFeedback" se mostrará al alumno: claro, específico, accionable.`,
  ].join('\n');

  return { system, user };
}

export interface ParsedGraderResponse {
  perCriterion: CriterionScoreView[];
  overallFeedback: string;
  proposedScore: number;
}

/**
 * Parsea la salida del modelo y la valida contra la rúbrica:
 *   - Extrae el primer bloque JSON balanceado.
 *   - Verifica que cada criterio de la rúbrica tenga su entrada.
 *   - Trunca scores que excedan el peso del criterio.
 *   - Calcula proposedScore = Σ scores.
 *
 * Lanza `GraderResponseParseError` si el JSON no es válido o no encaja con
 * la rúbrica esperada — el caller decide si reintentar o marcar fallida.
 */
export function parseGraderResponse(
  raw: string,
  criteria: RubricCriterionDto[],
): ParsedGraderResponse {
  const json = extractFirstJsonObject(raw);
  if (!json) throw new GraderResponseParseError('no se encontró JSON válido en la respuesta');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new GraderResponseParseError(`JSON malformado: ${(e as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new GraderResponseParseError('la respuesta no es un objeto JSON');
  }
  const obj = parsed as Record<string, unknown>;
  const overallFeedback = typeof obj.overallFeedback === 'string' ? obj.overallFeedback.trim() : '';
  if (!overallFeedback) {
    throw new GraderResponseParseError('falta overallFeedback o está vacío');
  }
  const perCriterionRaw = obj.perCriterion;
  if (!Array.isArray(perCriterionRaw)) {
    throw new GraderResponseParseError('perCriterion debe ser un array');
  }

  const byName = new Map<string, { score: number; justification: string }>();
  for (const row of perCriterionRaw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.name !== 'string') continue;
    const score = typeof r.score === 'number' ? Math.max(0, Math.floor(r.score)) : 0;
    const justification = typeof r.justification === 'string' ? r.justification.trim() : '';
    byName.set(r.name.toLowerCase(), { score, justification });
  }

  const perCriterion: CriterionScoreView[] = criteria.map((c) => {
    const found = byName.get(c.name.toLowerCase());
    if (!found) {
      throw new GraderResponseParseError(`falta el criterio "${c.name}" en la respuesta`);
    }
    // Truncar al peso del criterio: el modelo no debe pasarse aunque "quiera".
    const clamped = Math.min(found.score, c.weight);
    return {
      name: c.name,
      score: clamped,
      justification: found.justification || '(sin justificación)',
    };
  });

  const proposedScore = perCriterion.reduce((acc, p) => acc + p.score, 0);
  return { perCriterion, overallFeedback, proposedScore };
}

/**
 * Extrae el primer bloque JSON balanceado de un texto. Útil para tolerar
 * modelos que añaden "Aquí tienes el JSON:\n{...}" o que envuelven la
 * salida en bloques Markdown ``` ```. No es un parser completo: solo
 * cuenta llaves, ignorando las que están dentro de strings (con escape).
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
