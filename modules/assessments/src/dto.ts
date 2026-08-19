/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';

export const questionTypeSchema = z.enum([
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'TRUE_FALSE',
  'FILL_IN_BLANK',
  'SHORT_ANSWER',
  'LONG_ANSWER',
]);
export type QuestionTypeDto = z.infer<typeof questionTypeSchema>;

export const createQuizSchema = z.object({
  lessonId: z.string().uuid().optional(),
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  passThreshold: z.number().int().min(0).max(100).optional(),
  maxAttempts: z.number().int().positive().optional(),
  timeLimitMinutes: z.number().int().positive().optional(),
  shuffleQuestions: z.boolean().optional(),
  showFeedback: z.boolean().optional(),
});
export type CreateQuizDto = z.infer<typeof createQuizSchema>;

export const updateQuizSchema = createQuizSchema.partial();
export type UpdateQuizDto = z.infer<typeof updateQuizSchema>;

export const createOptionSchema = z.object({
  label: z.string().min(1).max(500),
  isCorrect: z.boolean(),
});
export type CreateOptionDto = z.infer<typeof createOptionSchema>;

export const createQuestionSchema = z
  .object({
    type: questionTypeSchema,
    prompt: z.string().min(3).max(2000),
    feedback: z.string().max(2000).optional(),
    points: z.number().int().positive().optional(),
    /** Para SINGLE_CHOICE / MULTIPLE_CHOICE / TRUE_FALSE. Vacío para FILL_IN_BLANK. */
    options: z.array(createOptionSchema).max(10).optional(),
    /** Solo para FILL_IN_BLANK. Vacío para los demás tipos. */
    acceptedAnswers: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'FILL_IN_BLANK') {
      if (!q.acceptedAnswers || q.acceptedAnswers.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FILL_IN_BLANK exige al menos una respuesta aceptada',
          path: ['acceptedAnswers'],
        });
      }
      return;
    }

    if (q.type === 'SHORT_ANSWER' || q.type === 'LONG_ANSWER') {
      // Tipos abiertos: no requieren options ni acceptedAnswers. La corrección
      // es manual via gradeAttempt.
      return;
    }

    // Tipos con opciones
    const options = q.options ?? [];
    if (options.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Tipos con opciones exigen al menos 2 opciones',
        path: ['options'],
      });
      return;
    }
    const correctCount = options.filter((o) => o.isCorrect).length;
    if (correctCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La pregunta debe tener al menos una opción correcta',
        path: ['options'],
      });
    }
    if (q.type === 'SINGLE_CHOICE' && correctCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SINGLE_CHOICE exige exactamente una opción correcta',
        path: ['options'],
      });
    }
    if (q.type === 'TRUE_FALSE') {
      if (options.length !== 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'TRUE_FALSE exige exactamente 2 opciones',
          path: ['options'],
        });
      }
      if (correctCount !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'TRUE_FALSE exige exactamente una opción correcta',
          path: ['options'],
        });
      }
    }
  });
export type CreateQuestionDto = z.infer<typeof createQuestionSchema>;

export const startAttemptSchema = z.object({
  quizId: z.string().uuid(),
  enrollmentId: z.string().uuid().optional(),
  /**
   * Se acepta por compatibilidad con clientes antiguos pero **se ignora**: la
   * leccion del intento sale de `quiz.lessonId`. Cuando la mandaba el cliente,
   * aprobar cualquier quiz facil apuntando aqui al examen final daba el examen
   * final por completado.
   */
  lessonId: z.string().uuid().optional(),
});
export type StartAttemptDto = z.infer<typeof startAttemptSchema>;

export const submitAttemptAnswerSchema = z.object({
  questionId: z.string().uuid(),
  /** Para SINGLE_CHOICE / MULTIPLE_CHOICE / TRUE_FALSE. */
  selectedOptionIds: z.array(z.string().uuid()).max(10).optional().default([]),
  /** Solo para FILL_IN_BLANK. */
  textAnswer: z.string().max(500).optional(),
});
export type SubmitAttemptAnswerDto = z.infer<typeof submitAttemptAnswerSchema>;

export const submitAttemptSchema = z.object({
  attemptId: z.string().uuid(),
  answers: z.array(submitAttemptAnswerSchema).min(1).max(200),
});
export type SubmitAttemptDto = z.infer<typeof submitAttemptSchema>;

export const gradeAnswerSchema = z.object({
  questionId: z.string().uuid(),
  scoreEarned: z.number().int().min(0),
  feedback: z.string().max(2000).optional(),
});
export type GradeAnswerDto = z.infer<typeof gradeAnswerSchema>;

export const gradeAttemptSchema = z.object({
  /** Lista de respuestas con la puntuación que el formador les asigna.
   *  Solo deberían venir las respuestas a preguntas SHORT_ANSWER / LONG_ANSWER;
   *  el service ignora silenciosamente entries para preguntas auto-corregidas. */
  grades: z.array(gradeAnswerSchema).min(1).max(200),
});
export type GradeAttemptDto = z.infer<typeof gradeAttemptSchema>;
