import { describe, expect, it } from 'vitest';
import { scoreAttempt, type ScoringQuestion } from '../src/scoring.js';

const singleChoice = (
  id: string,
  options: { id: string; correct: boolean }[],
): ScoringQuestion => ({
  id,
  type: 'SINGLE_CHOICE',
  points: 1,
  options: options.map((o) => ({ id: o.id, isCorrect: o.correct })),
});

const multipleChoice = (
  id: string,
  options: { id: string; correct: boolean }[],
  points = 2,
): ScoringQuestion => ({
  id,
  type: 'MULTIPLE_CHOICE',
  points,
  options: options.map((o) => ({ id: o.id, isCorrect: o.correct })),
});

const trueFalse = (id: string, options: { id: string; correct: boolean }[]): ScoringQuestion => ({
  id,
  type: 'TRUE_FALSE',
  points: 1,
  options: options.map((o) => ({ id: o.id, isCorrect: o.correct })),
});

const fillInBlank = (id: string, accepted: string[], points = 1): ScoringQuestion => ({
  id,
  type: 'FILL_IN_BLANK',
  points,
  options: [],
  acceptedAnswers: accepted,
});

describe('scoreAttempt', () => {
  it('todas correctas: 100% y passed', () => {
    const questions = [
      singleChoice('q1', [
        { id: 'q1-a', correct: true },
        { id: 'q1-b', correct: false },
      ]),
      trueFalse('q2', [
        { id: 'q2-true', correct: false },
        { id: 'q2-false', correct: true },
      ]),
    ];
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['q1-a'] },
      { questionId: 'q2', selectedOptionIds: ['q2-false'] },
    ];

    const result = scoreAttempt(questions, answers, 60);
    expect(result.scoreEarned).toBe(2);
    expect(result.scoreMax).toBe(2);
    expect(result.scorePercent).toBe(100);
    expect(result.passed).toBe(true);
    expect(result.perAnswer).toEqual([
      { questionId: 'q1', isCorrect: true, scoreEarned: 1 },
      { questionId: 'q2', isCorrect: true, scoreEarned: 1 },
    ]);
  });

  it('todas incorrectas: 0% y not passed', () => {
    const questions = [
      singleChoice('q1', [
        { id: 'a', correct: true },
        { id: 'b', correct: false },
      ]),
    ];
    const answers = [{ questionId: 'q1', selectedOptionIds: ['b'] }];

    const result = scoreAttempt(questions, answers, 60);
    expect(result.scorePercent).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.perAnswer[0]).toEqual({ questionId: 'q1', isCorrect: false, scoreEarned: 0 });
  });

  it('MULTIPLE_CHOICE exige conjunto exacto: marcar todas las correctas + ninguna incorrecta', () => {
    const questions = [
      multipleChoice('q1', [
        { id: 'a', correct: true },
        { id: 'b', correct: true },
        { id: 'c', correct: false },
      ]),
    ];

    expect(
      scoreAttempt(questions, [{ questionId: 'q1', selectedOptionIds: ['a', 'b'] }], 60).passed,
    ).toBe(true);
    expect(
      scoreAttempt(questions, [{ questionId: 'q1', selectedOptionIds: ['a'] }], 60).perAnswer[0]
        ?.isCorrect,
    ).toBe(false);
    expect(
      scoreAttempt(questions, [{ questionId: 'q1', selectedOptionIds: ['a', 'b', 'c'] }], 60)
        .perAnswer[0]?.isCorrect,
    ).toBe(false);
    expect(
      scoreAttempt(questions, [{ questionId: 'q1', selectedOptionIds: ['c'] }], 60).perAnswer[0]
        ?.isCorrect,
    ).toBe(false);
  });

  it('SINGLE_CHOICE: marcar 2 opciones (incluso si una es correcta) cuenta como fallo', () => {
    const questions = [
      singleChoice('q1', [
        { id: 'a', correct: true },
        { id: 'b', correct: false },
      ]),
    ];
    const answers = [{ questionId: 'q1', selectedOptionIds: ['a', 'b'] }];

    const result = scoreAttempt(questions, answers, 60);
    expect(result.perAnswer[0]?.isCorrect).toBe(false);
  });

  it('pregunta sin respuesta: 0 puntos en esa pregunta, no rompe el cálculo', () => {
    const questions = [
      singleChoice('q1', [
        { id: 'a', correct: true },
        { id: 'b', correct: false },
      ]),
      singleChoice('q2', [
        { id: 'a', correct: true },
        { id: 'b', correct: false },
      ]),
    ];
    const answers = [{ questionId: 'q1', selectedOptionIds: ['a'] }];

    const result = scoreAttempt(questions, answers, 60);
    expect(result.scoreEarned).toBe(1);
    expect(result.scoreMax).toBe(2);
    expect(result.scorePercent).toBe(50);
    expect(result.passed).toBe(false);
  });

  it('puntos por pregunta: el peso se respeta en el total', () => {
    const questions = [
      singleChoice('q1', [
        { id: 'a', correct: true },
        { id: 'b', correct: false },
      ]),
      multipleChoice(
        'q2',
        [
          { id: 'a', correct: true },
          { id: 'b', correct: true },
        ],
        4,
      ),
    ];
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['a'] },
      { questionId: 'q2', selectedOptionIds: ['a', 'b'] },
    ];
    const result = scoreAttempt(questions, answers, 60);
    expect(result.scoreMax).toBe(5);
    expect(result.scoreEarned).toBe(5);
    expect(result.scorePercent).toBe(100);
  });

  it('passed depende del threshold: justo en el umbral pasa, por debajo no', () => {
    const q = singleChoice('q1', [
      { id: 'a', correct: true },
      { id: 'b', correct: false },
    ]);
    const correctAnswer = [{ questionId: 'q1', selectedOptionIds: ['a'] }];
    const wrongAnswer = [{ questionId: 'q1', selectedOptionIds: ['b'] }];

    expect(scoreAttempt([q], correctAnswer, 100).passed).toBe(true);
    expect(scoreAttempt([q], wrongAnswer, 0).passed).toBe(true);
    expect(scoreAttempt([q], wrongAnswer, 1).passed).toBe(false);
  });

  it('quiz vacío: 0/0 → 0% y no pasa salvo threshold 0', () => {
    expect(scoreAttempt([], [], 60)).toEqual({
      scoreEarned: 0,
      scoreMax: 0,
      scorePercent: 0,
      passed: false,
      perAnswer: [],
    });
    expect(scoreAttempt([], [], 0).passed).toBe(true);
  });

  it('respuestas extra para preguntas inexistentes son ignoradas', () => {
    const questions = [
      singleChoice('q1', [
        { id: 'a', correct: true },
        { id: 'b', correct: false },
      ]),
    ];
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['a'] },
      { questionId: 'q-fantasma', selectedOptionIds: ['x'] },
    ];
    const result = scoreAttempt(questions, answers, 60);
    expect(result.scoreEarned).toBe(1);
    expect(result.scoreMax).toBe(1);
    expect(result.perAnswer).toHaveLength(1);
  });

  it('threshold fuera de rango: lanza RangeError', () => {
    expect(() => scoreAttempt([], [], -1)).toThrow(RangeError);
    expect(() => scoreAttempt([], [], 101)).toThrow(RangeError);
  });

  describe('FILL_IN_BLANK', () => {
    const q = fillInBlank('q1', ['París', 'Paris']);

    it('coincidencia exacta cuenta como correcta', () => {
      const r = scoreAttempt(
        [q],
        [{ questionId: 'q1', selectedOptionIds: [], textAnswer: 'París' }],
        60,
      );
      expect(r.perAnswer[0]?.isCorrect).toBe(true);
    });

    it('insensible a mayúsculas/minúsculas', () => {
      const r = scoreAttempt(
        [q],
        [{ questionId: 'q1', selectedOptionIds: [], textAnswer: 'PARIS' }],
        60,
      );
      expect(r.perAnswer[0]?.isCorrect).toBe(true);
    });

    it('insensible a acentos: paris (sin acento) coincide con París aceptada', () => {
      const r = scoreAttempt(
        [q],
        [{ questionId: 'q1', selectedOptionIds: [], textAnswer: 'paris' }],
        60,
      );
      expect(r.perAnswer[0]?.isCorrect).toBe(true);
    });

    it('respeta espaciado: trim + colapsa espacios internos', () => {
      const r = scoreAttempt(
        [q],
        [{ questionId: 'q1', selectedOptionIds: [], textAnswer: '  París   ' }],
        60,
      );
      expect(r.perAnswer[0]?.isCorrect).toBe(true);
    });

    it('respuesta diferente: incorrecta', () => {
      const r = scoreAttempt(
        [q],
        [{ questionId: 'q1', selectedOptionIds: [], textAnswer: 'Madrid' }],
        60,
      );
      expect(r.perAnswer[0]?.isCorrect).toBe(false);
    });

    it('respuesta vacía: incorrecta (no es null/undefined-friendly)', () => {
      const r = scoreAttempt(
        [q],
        [{ questionId: 'q1', selectedOptionIds: [], textAnswer: '   ' }],
        60,
      );
      expect(r.perAnswer[0]?.isCorrect).toBe(false);
    });

    it('sin textAnswer en la respuesta: incorrecta sin romper', () => {
      const r = scoreAttempt([q], [{ questionId: 'q1', selectedOptionIds: [] }], 60);
      expect(r.perAnswer[0]?.isCorrect).toBe(false);
    });

    it('múltiples respuestas aceptadas: cualquiera basta', () => {
      const multi = fillInBlank('q1', ['NodeJS', 'Node.js', 'node']);
      expect(
        scoreAttempt(
          [multi],
          [{ questionId: 'q1', selectedOptionIds: [], textAnswer: 'Node.js' }],
          60,
        ).perAnswer[0]?.isCorrect,
      ).toBe(true);
      expect(
        scoreAttempt(
          [multi],
          [{ questionId: 'q1', selectedOptionIds: [], textAnswer: 'NODEJS' }],
          60,
        ).perAnswer[0]?.isCorrect,
      ).toBe(true);
      expect(
        scoreAttempt(
          [multi],
          [{ questionId: 'q1', selectedOptionIds: [], textAnswer: 'Node.JS' }],
          60,
        ).perAnswer[0]?.isCorrect,
      ).toBe(true);
    });

    it('mezcla con otros tipos: ambos contribuyen al total', () => {
      const sc = singleChoice('q-sc', [
        { id: 'a', correct: true },
        { id: 'b', correct: false },
      ]);
      const fb = fillInBlank('q-fb', ['Madrid'], 2);
      const result = scoreAttempt(
        [sc, fb],
        [
          { questionId: 'q-sc', selectedOptionIds: ['a'] },
          { questionId: 'q-fb', selectedOptionIds: [], textAnswer: 'madrid' },
        ],
        60,
      );
      expect(result.scoreEarned).toBe(3);
      expect(result.scoreMax).toBe(3);
      expect(result.passed).toBe(true);
    });
  });
});
