/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { QuizFormadorView } from '@/modules/assessments';

/**
 * Borrador del CUESTIONARIO del modo sencillo: lo que la creadora edita en el
 * formulario (preguntas de una o varias respuestas correctas y la nota para
 * aprobar) y su paso a las llamadas del módulo de evaluaciones
 * (`mod.assessments`). Funciones puras: ver `quiz-draft.test.ts`.
 */

export interface DraftOption {
  label: string;
  correct: boolean;
}

export interface DraftQuestion {
  prompt: string;
  /** Varias respuestas correctas (MULTIPLE_CHOICE); si no, una (SINGLE_CHOICE). */
  multiple: boolean;
  options: DraftOption[];
}

export interface QuizDraft {
  passThreshold: number;
  questions: DraftQuestion[];
}

/** Notas para aprobar que ofrece el selector (en %). */
export const PASS_THRESHOLDS = [50, 60, 70, 80, 90, 100] as const;
export const DEFAULT_PASS_THRESHOLD = 60;
export const MAX_OPTIONS = 6;
export const MAX_QUESTIONS = 50;

export function emptyQuestion(): DraftQuestion {
  return {
    prompt: '',
    multiple: false,
    options: [
      { label: '', correct: true },
      { label: '', correct: false },
    ],
  };
}

export function emptyDraft(): QuizDraft {
  return { passThreshold: DEFAULT_PASS_THRESHOLD, questions: [emptyQuestion()] };
}

/** Lo que ya está guardado → borrador editable (solo los tipos con opciones). */
export function draftFromQuiz(quiz: QuizFormadorView): QuizDraft {
  const questions = quiz.questions
    .filter(
      (q) => q.type === 'SINGLE_CHOICE' || q.type === 'MULTIPLE_CHOICE' || q.type === 'TRUE_FALSE',
    )
    .map((q) => ({
      prompt: q.prompt,
      multiple: q.type === 'MULTIPLE_CHOICE',
      options: q.options.map((o) => ({ label: o.label, correct: o.isCorrect })),
    }));
  return {
    passThreshold: quiz.passThreshold,
    questions: questions.length > 0 ? questions : [emptyQuestion()],
  };
}

/**
 * Marcar una respuesta como correcta. Con una sola correcta, marcar otra
 * desmarca la anterior (se comporta como un botón de radio); con varias, se
 * alterna.
 */
export function toggleCorrect(q: DraftQuestion, index: number): DraftQuestion {
  if (q.multiple) {
    return {
      ...q,
      options: q.options.map((o, i) => (i === index ? { ...o, correct: !o.correct } : o)),
    };
  }
  return { ...q, options: q.options.map((o, i) => ({ ...o, correct: i === index })) };
}

/** Pasar de «varias correctas» a «una»: se queda la primera marcada. */
export function setMultiple(q: DraftQuestion, multiple: boolean): DraftQuestion {
  if (multiple || q.multiple === multiple) return { ...q, multiple };
  const first = Math.max(
    0,
    q.options.findIndex((o) => o.correct),
  );
  return {
    multiple,
    prompt: q.prompt,
    options: q.options.map((o, i) => ({ ...o, correct: i === first })),
  };
}

export type DraftProblem =
  | { code: 'tituloCorto' }
  | { code: 'sinPreguntas' }
  | { code: 'preguntaCorta'; n: number }
  | { code: 'pocasRespuestas'; n: number }
  | { code: 'sinCorrecta'; n: number }
  | { code: 'unaCorrecta'; n: number };

/**
 * Primer problema que impide guardar (o `null`). Las mismas reglas que valida
 * el servidor (`createQuestionSchema`, título del quiz de 3 letras o más), pero
 * dichas en la pregunta concreta (`n` empieza en 1).
 */
export function draftProblem(title: string, draft: QuizDraft): DraftProblem | null {
  if (title.trim().length < 3) return { code: 'tituloCorto' };
  if (draft.questions.length === 0) return { code: 'sinPreguntas' };
  for (const [i, q] of draft.questions.entries()) {
    const n = i + 1;
    if (q.prompt.trim().length < 3) return { code: 'preguntaCorta', n };
    const filled = q.options.filter((o) => o.label.trim());
    if (filled.length < 2) return { code: 'pocasRespuestas', n };
    const correct = filled.filter((o) => o.correct).length;
    if (correct === 0) return { code: 'sinCorrecta', n };
    if (!q.multiple && correct !== 1) return { code: 'unaCorrecta', n };
  }
  return null;
}

export interface QuestionPayload {
  type: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE';
  prompt: string;
  options: Array<{ label: string; isCorrect: boolean }>;
}

/** Preguntas listas para `POST …/questions` (sin las respuestas vacías). */
export function questionPayloads(draft: QuizDraft): QuestionPayload[] {
  return draft.questions.map((q) => ({
    type: q.multiple ? 'MULTIPLE_CHOICE' : 'SINGLE_CHOICE',
    prompt: q.prompt.trim(),
    options: q.options
      .filter((o) => o.label.trim())
      .map((o) => ({ label: o.label.trim(), isCorrect: o.correct })),
  }));
}

/**
 * ¿Hay que rehacer las preguntas? El módulo no edita una pregunta en sitio
 * (borra y añade al final), así que si cambia cualquiera se rehacen todas en
 * orden; si no cambia ninguna, no se toca nada (los intentos ya hechos siguen
 * apuntando a las mismas preguntas).
 */
export function questionsChanged(before: QuizDraft, after: QuizDraft): boolean {
  return JSON.stringify(questionPayloads(before)) !== JSON.stringify(questionPayloads(after));
}
