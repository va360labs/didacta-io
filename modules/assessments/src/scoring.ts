/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Scoring engine puro de mod.assessments.
 *
 * Sin dependencias de Prisma ni ningún side effect — todo entrada / salida —
 * para que sea testeable sin DB y reutilizable desde cualquier capa.
 *
 * Reglas v0.3:
 * - SINGLE_CHOICE / TRUE_FALSE: el alumno acierta solo si selecciona EXACTAMENTE
 *   la opción correcta y nada más. No hay crédito parcial.
 * - MULTIPLE_CHOICE: el alumno acierta solo si el conjunto de opciones marcadas
 *   coincide EXACTAMENTE con el conjunto de opciones correctas. Sin crédito parcial.
 * - FILL_IN_BLANK: el alumno escribe un texto libre. Acierta si tras normalizar
 *   (trim + lowercase + colapsar espacios + sin acentos) coincide con CUALQUIERA
 *   de las respuestas aceptadas (también normalizadas).
 * - SHORT_ANSWER / LONG_ANSWER: tipos abiertos sin auto-corrección. El scoring
 *   marca la respuesta como `needsReview: true`, `isCorrect: false`,
 *   `scoreEarned: 0`. El total del quiz refleja solo lo auto-corregible hasta
 *   que el formador califique manualmente vía `gradeAttempt` en el service.
 * - Si el alumno no responde una pregunta, cuenta como fallo (0 puntos en esa pregunta).
 * - Pasa el quiz si scorePercent >= passThreshold del quiz (cálculo final
 *   sólo válido cuando `needsReview` global es false).
 */

export type ScoringQuestionType =
  | 'SINGLE_CHOICE'
  | 'MULTIPLE_CHOICE'
  | 'TRUE_FALSE'
  | 'FILL_IN_BLANK'
  | 'SHORT_ANSWER'
  | 'LONG_ANSWER';

const OPEN_TYPES: ReadonlySet<ScoringQuestionType> = new Set(['SHORT_ANSWER', 'LONG_ANSWER']);
function isOpenType(t: ScoringQuestionType): boolean {
  return OPEN_TYPES.has(t);
}

export interface ScoringOption {
  id: string;
  isCorrect: boolean;
}

export interface ScoringQuestion {
  id: string;
  type: ScoringQuestionType;
  points: number;
  options: ScoringOption[];
  /** Solo para FILL_IN_BLANK: respuestas válidas. Vacío para los demás tipos. */
  acceptedAnswers?: string[];
}

export interface ScoringAnswer {
  questionId: string;
  selectedOptionIds: string[];
  /** Solo para FILL_IN_BLANK: texto que escribió el alumno. */
  textAnswer?: string;
}

export interface ScoredAnswer {
  questionId: string;
  isCorrect: boolean;
  scoreEarned: number;
  /** True para SHORT_ANSWER / LONG_ANSWER: el formador debe corregir esta respuesta. */
  needsReview: boolean;
}

export interface ScoringResult {
  scoreEarned: number;
  scoreMax: number;
  scorePercent: number;
  passed: boolean;
  /** True si CUALQUIER pregunta requiere corrección manual. Mientras esto sea
   *  true, scorePercent y passed son provisionales. */
  needsReview: boolean;
  perAnswer: ScoredAnswer[];
}

/**
 * Evalúa las respuestas de un intento contra las preguntas del quiz.
 *
 * @param questions  Todas las preguntas del quiz con sus opciones (incluyendo `isCorrect`).
 * @param answers    Respuestas del alumno. Si falta una respuesta para una pregunta,
 *                   se computa como respuesta vacía (= fallo = 0 puntos).
 * @param passThreshold Umbral de aprobación en porcentaje (0-100).
 * @returns Resultado con puntos, porcentaje, pasa/no pasa y desglose por respuesta.
 */
export function scoreAttempt(
  questions: ScoringQuestion[],
  answers: ScoringAnswer[],
  passThreshold: number,
): ScoringResult {
  if (passThreshold < 0 || passThreshold > 100) {
    throw new RangeError(`passThreshold debe estar entre 0 y 100 (recibido: ${passThreshold})`);
  }

  const answerByQuestion = new Map<string, ScoringAnswer>();
  for (const a of answers) answerByQuestion.set(a.questionId, a);

  const perAnswer: ScoredAnswer[] = [];
  let scoreEarned = 0;
  let scoreMax = 0;
  let needsReview = false;

  for (const q of questions) {
    scoreMax += q.points;
    const a = answerByQuestion.get(q.id);

    if (isOpenType(q.type)) {
      // Tipos abiertos: deferred al formador. Marcamos needsReview, no
      // aportan puntos al total provisional.
      needsReview = true;
      perAnswer.push({
        questionId: q.id,
        isCorrect: false,
        scoreEarned: 0,
        needsReview: true,
      });
      continue;
    }

    let isCorrect: boolean;
    if (q.type === 'FILL_IN_BLANK') {
      const expected = (q.acceptedAnswers ?? []).map(normalize).filter((s) => s.length > 0);
      const actual = normalize(a?.textAnswer ?? '');
      isCorrect = actual.length > 0 && expected.includes(actual);
    } else {
      const selected = new Set(a?.selectedOptionIds ?? []);
      const correct = new Set(q.options.filter((o) => o.isCorrect).map((o) => o.id));
      isCorrect = setsEqual(selected, correct);
    }

    const earned = isCorrect ? q.points : 0;
    scoreEarned += earned;
    perAnswer.push({ questionId: q.id, isCorrect, scoreEarned: earned, needsReview: false });
  }

  const scorePercent = scoreMax === 0 ? 0 : Math.round((scoreEarned / scoreMax) * 100);
  const passed = scorePercent >= passThreshold;

  return { scoreEarned, scoreMax, scorePercent, passed, needsReview, perAnswer };
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Normaliza un texto para comparar respuestas FILL_IN_BLANK.
 *
 * Lo aplicamos tanto a la respuesta del alumno como a cada respuesta aceptada,
 * de modo que el formador no tenga que prever variantes de mayúscula/acento /
 * espaciado: si pone "París" como respuesta, "paris", " PARIS ", "Paris " o
 * "p a r í s" (con espaciado raro pero misma letra) cuentan como correctas.
 */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
