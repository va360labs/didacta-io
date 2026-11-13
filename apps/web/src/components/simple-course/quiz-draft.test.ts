/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import type { QuizFormadorView } from '@/modules/assessments';
import {
  draftFromQuiz,
  draftProblem,
  emptyDraft,
  emptyQuestion,
  questionPayloads,
  questionsChanged,
  setMultiple,
  toggleCorrect,
  type QuizDraft,
} from './quiz-draft';

function ready(): QuizDraft {
  return {
    passThreshold: 60,
    questions: [
      {
        prompt: '¿Qué molienda para espresso?',
        multiple: false,
        options: [
          { label: 'Fina', correct: true },
          { label: 'Gruesa', correct: false },
          { label: '  ', correct: false },
        ],
      },
    ],
  };
}

describe('borrador del cuestionario sencillo', () => {
  it('nace con una pregunta de dos respuestas y aprobado al 60 %', () => {
    const d = emptyDraft();
    expect(d.passThreshold).toBe(60);
    expect(d.questions).toHaveLength(1);
    expect(d.questions[0]!.options).toHaveLength(2);
  });

  it('con una sola correcta, marcar otra desmarca la anterior; con varias, alterna', () => {
    const q = {
      ...emptyQuestion(),
      options: [
        { label: 'a', correct: true },
        { label: 'b', correct: false },
      ],
    };
    expect(toggleCorrect(q, 1).options.map((o) => o.correct)).toEqual([false, true]);
    const m = setMultiple(q, true);
    expect(toggleCorrect(m, 1).options.map((o) => o.correct)).toEqual([true, true]);
    // Volver a «una» se queda con la primera marcada.
    const back = setMultiple(
      {
        ...m,
        options: [
          { label: 'a', correct: false },
          { label: 'b', correct: true },
          { label: 'c', correct: true },
        ],
      },
      false,
    );
    expect(back.options.map((o) => o.correct)).toEqual([false, true, false]);
  });

  it('dice qué falta, en la pregunta concreta', () => {
    expect(draftProblem('Hi', ready())).toEqual({ code: 'tituloCorto' });
    expect(draftProblem('Repaso', ready())).toBeNull();
    const sinPregunta = ready();
    sinPregunta.questions[0]!.prompt = ' ';
    expect(draftProblem('Repaso', sinPregunta)).toEqual({ code: 'preguntaCorta', n: 1 });
    const una = ready();
    una.questions[0]!.options[1]!.label = '';
    expect(draftProblem('Repaso', una)).toEqual({ code: 'pocasRespuestas', n: 1 });
    const ninguna = ready();
    ninguna.questions[0]!.options[0]!.correct = false;
    expect(draftProblem('Repaso', ninguna)).toEqual({ code: 'sinCorrecta', n: 1 });
    const dos = ready();
    dos.questions[0]!.options[1]!.correct = true;
    expect(draftProblem('Repaso', dos)).toEqual({ code: 'unaCorrecta', n: 1 });
    dos.questions[0]!.multiple = true;
    expect(draftProblem('Repaso', dos)).toBeNull();
    expect(draftProblem('Repaso', { passThreshold: 60, questions: [] })).toEqual({
      code: 'sinPreguntas',
    });
  });

  it('manda al módulo de evaluaciones solo las respuestas escritas y el tipo correcto', () => {
    expect(questionPayloads(ready())).toEqual([
      {
        type: 'SINGLE_CHOICE',
        prompt: '¿Qué molienda para espresso?',
        options: [
          { label: 'Fina', isCorrect: true },
          { label: 'Gruesa', isCorrect: false },
        ],
      },
    ]);
    const m = ready();
    m.questions[0]!.multiple = true;
    expect(questionPayloads(m)[0]!.type).toBe('MULTIPLE_CHOICE');
  });

  it('solo rehace las preguntas si algo cambió (la nota no cuenta)', () => {
    const a = ready();
    expect(questionsChanged(a, { ...ready(), passThreshold: 80 })).toBe(false);
    const b = ready();
    b.questions[0]!.options[0]!.label = 'Muy fina';
    expect(questionsChanged(a, b)).toBe(true);
  });

  it('lee un cuestionario guardado (los tipos abiertos no entran en el editor sencillo)', () => {
    const quiz = {
      passThreshold: 70,
      questions: [
        {
          id: 'q1',
          type: 'MULTIPLE_CHOICE',
          prompt: 'Elige dos',
          feedback: null,
          position: 1,
          points: 1,
          acceptedAnswers: [],
          options: [
            { id: 'o1', label: 'x', isCorrect: true, position: 1 },
            { id: 'o2', label: 'y', isCorrect: true, position: 2 },
          ],
        },
        {
          id: 'q2',
          type: 'LONG_ANSWER',
          prompt: 'Explica',
          feedback: null,
          position: 2,
          points: 1,
          acceptedAnswers: [],
          options: [],
        },
      ],
    } as unknown as QuizFormadorView;
    const d = draftFromQuiz(quiz);
    expect(d.passThreshold).toBe(70);
    expect(d.questions).toHaveLength(1);
    expect(d.questions[0]).toMatchObject({ multiple: true, prompt: 'Elige dos' });
  });
});
