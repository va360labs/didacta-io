import { z } from 'zod';

/**
 * DTOs del módulo AI Grader (LMS-91).
 *
 * Diseño:
 *   - La rúbrica vive a nivel de pregunta. Cada SHORT_ANSWER / LONG_ANSWER
 *     tiene 0 o 1 rúbrica (one-to-one con la question).
 *   - Cada criterio tiene un peso (sum debe = maxScore = puntos de la pregunta).
 *   - El formador puede ajustar la rúbrica entre intentos sin invalidar
 *     attempts pasados, pero las nuevas sugerencias usan la rúbrica vigente.
 */

export const rubricCriterionSchema = z.object({
  /** Nombre corto del criterio (ej. "Claridad", "Profundidad técnica"). */
  name: z.string().trim().min(2).max(120),
  /** Descripción de qué busca este criterio. La IA la usa de guía. */
  description: z.string().trim().min(5).max(1000),
  /** Peso del criterio en puntos. La suma de pesos = maxScore de la pregunta. */
  weight: z.number().int().min(1).max(100),
});
export type RubricCriterionDto = z.infer<typeof rubricCriterionSchema>;

export const upsertRubricSchema = z
  .object({
    /** Texto que orienta a la IA sobre qué tipo de respuesta esperar. */
    instructions: z.string().trim().min(10).max(2000),
    /** Lista de criterios. Mínimo 1, máximo 8 para mantener prompts manejables. */
    criteria: z.array(rubricCriterionSchema).min(1).max(8),
    /** Si false, la IA no se invoca para esta pregunta aunque el quiz tenga AI Grader. */
    enabled: z.boolean().optional(),
  })
  .superRefine((r, ctx) => {
    const names = new Set<string>();
    for (const c of r.criteria) {
      const key = c.name.toLowerCase();
      if (names.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Criterio duplicado: "${c.name}". Cada nombre debe ser único.`,
          path: ['criteria'],
        });
      }
      names.add(key);
    }
  });
export type UpsertRubricDto = z.infer<typeof upsertRubricSchema>;

export const suggestForAttemptSchema = z.object({
  /** Si true, regenera sugerencias aunque ya existan (sobreescribe). */
  force: z.boolean().optional(),
});
export type SuggestForAttemptDto = z.infer<typeof suggestForAttemptSchema>;

// ─── Views (response shapes) ─────────────────────────────────────────

export interface RubricView {
  id: string;
  questionId: string;
  instructions: string;
  criteria: RubricCriterionDto[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CriterionScoreView {
  /** Coincide por `name` con el criterio de la rúbrica. */
  name: string;
  /** Score asignado por la IA a este criterio (0..weight). */
  score: number;
  /** Justificación corta (1-2 frases) de por qué ese score. */
  justification: string;
}

export interface SuggestionView {
  id: string;
  attemptId: string;
  answerId: string;
  questionId: string;
  /** Score total propuesto (suma de criterios). 0 ≤ proposed ≤ question.points. */
  proposedScore: number;
  /** Desglose por criterio para que el formador entienda el racional. */
  perCriterion: CriterionScoreView[];
  /** Feedback global devuelto al alumno si el formador acepta. */
  overallFeedback: string;
  /** Modelo y provider que generaron la sugerencia (audit). */
  provider: string;
  model: string;
  /** True si el formador ya la aplicó al attempt (vía gradeAttempt). */
  applied: boolean;
  createdAt: string;
}

export interface SuggestForAttemptResultView {
  attemptId: string;
  generated: SuggestionView[];
  /** Preguntas que se omitieron (sin rúbrica, deshabilitadas, etc.) con motivo. */
  skipped: Array<{ questionId: string; reason: string }>;
  tokensUsed: { input: number; output: number };
  durationMs: number;
}
