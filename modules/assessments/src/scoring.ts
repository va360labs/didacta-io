/**
 * Scoring engine puro de mod.assessments.
 *
 * Sin dependencias de Prisma ni ningún side effect — todo entrada / salida —
 * para que sea testeable sin DB y reutilizable desde cualquier capa.
 *
 * Reglas v0.1:
 * - SINGLE_CHOICE / TRUE_FALSE: el alumno acierta solo si selecciona EXACTAMENTE
 *   la opción correcta y nada más. No hay crédito parcial.
 * - MULTIPLE_CHOICE: el alumno acierta solo si el conjunto de opciones marcadas
 *   coincide EXACTAMENTE con el conjunto de opciones correctas. Sin crédito parcial.
 *   (En PRs futuros podría introducirse crédito parcial — por ahora binario por
 *    pregunta para mantener la corrección simple y predecible.)
 * - Si el alumno no responde una pregunta, cuenta como fallo (0 puntos en esa pregunta).
 * - Pasa el quiz si scorePercent >= passThreshold del quiz.
 */

export type ScoringQuestionType = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TRUE_FALSE';

export interface ScoringOption {
  id: string;
  isCorrect: boolean;
}

export interface ScoringQuestion {
  id: string;
  type: ScoringQuestionType;
  points: number;
  options: ScoringOption[];
}

export interface ScoringAnswer {
  questionId: string;
  selectedOptionIds: string[];
}

export interface ScoredAnswer {
  questionId: string;
  isCorrect: boolean;
  scoreEarned: number;
}

export interface ScoringResult {
  scoreEarned: number;
  scoreMax: number;
  scorePercent: number;
  passed: boolean;
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

  for (const q of questions) {
    scoreMax += q.points;
    const a = answerByQuestion.get(q.id);
    const selected = new Set(a?.selectedOptionIds ?? []);
    const correct = new Set(q.options.filter((o) => o.isCorrect).map((o) => o.id));

    const isCorrect = setsEqual(selected, correct);
    const earned = isCorrect ? q.points : 0;
    scoreEarned += earned;
    perAnswer.push({ questionId: q.id, isCorrect, scoreEarned: earned });
  }

  const scorePercent = scoreMax === 0 ? 0 : Math.round((scoreEarned / scoreMax) * 100);
  const passed = scorePercent >= passThreshold;

  return { scoreEarned, scoreMax, scorePercent, passed, perAnswer };
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
