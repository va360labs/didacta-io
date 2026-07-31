/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';

/**
 * DTOs del módulo AI Tutor (LMS-90).
 */

export const askSchema = z.object({
  question: z.string().trim().min(3).max(2000),
  /** Si se omite, no se incluye historia (cada pregunta es independiente). */
  conversationId: z.string().uuid().optional(),
  /** Top-K de chunks relevantes para el RAG. Default 5. */
  topK: z.number().int().min(1).max(20).optional(),
  /**
   * Lección que el alumno está viendo cuando pregunta. Cambia la respuesta:
   * «no me funciona el webhook» no significa lo mismo en el capítulo 21 que en
   * el 45. Los fragmentos de esta lección se priorizan sobre el resto del curso.
   */
  lessonId: z.string().uuid().optional(),
  /** Segundo del vídeo en el que va el alumno. Sirve para situar la duda. */
  positionSeconds: z.number().int().min(0).max(86_400).optional(),
});
export type AskDto = z.infer<typeof askSchema>;

export const indexCourseSchema = z.object({
  /** Si true, fuerza re-indexación borrando chunks previos del curso. */
  force: z.boolean().optional(),
});
export type IndexCourseDto = z.infer<typeof indexCourseSchema>;

export interface ChunkView {
  id: string;
  courseId: string;
  lessonId: string | null;
  ordinal: number;
  content: string;
  tokensCount: number;
  createdAt: string;
}

export interface CitationView {
  lessonId: string;
  /** Título de la lección (se hidrata en el response). */
  lessonTitle: string | null;
  chunkOrdinal: number;
  /** Snippet del chunk citado (primeros 200 chars). */
  snippet: string;
  /**
   * Segundo del vídeo donde empieza lo citado, si el fragmento viene de una
   * transcripción con marcas de tiempo. Permite enlazar «minuto 12:34» al punto
   * exacto del vídeo. Null cuando el fragmento es de texto sin marcas.
   */
  startSeconds: number | null;
}

export interface AskResponseView {
  /** Respuesta generada por el modelo (Markdown plano). */
  answer: string;
  /** Citas a las lecciones que respaldan la respuesta. */
  citations: CitationView[];
  /** ID de la conversación (puede ser nuevo si se omitió en el request). */
  conversationId: string;
  /** Tokens consumidos en esta llamada (para enforce de cuota). */
  tokensUsed: {
    input: number;
    output: number;
  };
  /** Cuota diaria de preguntas tras contar ésta. */
  quota: {
    used: number;
    limit: number;
    remaining: number;
  };
}

export interface IndexCourseResultView {
  courseId: string;
  lessonsProcessed: number;
  chunksGenerated: number;
  tokensUsed: number;
  durationMs: number;
}

// ─── Revisión de respuestas y realimentación del conocimiento ───────────────

/** Estados de revisión de una respuesta del tutor. */
export const REVIEW_STATUSES = ['PENDING', 'OK', 'CORRECTED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const listAnswersSchema = z.object({
  /** Filtra por curso. Si se omite, todos. */
  courseId: z.string().uuid().optional(),
  status: z.enum(REVIEW_STATUSES).optional(),
  /**
   * Solo respuestas sin ninguna cita al material. Es el mejor detector de
   * respuestas flojas: si el tutor no pudo apoyarse en nada del curso, o se lo
   * inventó o falta contenido.
   *
   * NO se valida con `z.coerce.boolean()`: viene de la query string, y para
   * `coerce` cualquier cadena no vacía es `true` — `?soloSinCitas=false`
   * activaría el filtro. Aquí solo el literal 'true' (o un booleano real)
   * cuenta.
   */
  soloSinCitas: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
  /** Búsqueda en el texto de la pregunta o de la respuesta. */
  q: z.string().trim().min(2).max(120).optional(),
  /** Rango por fecha de la respuesta (ISO date, inclusive/exclusivo). */
  desde: z.string().datetime().optional(),
  hasta: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListAnswersDto = z.infer<typeof listAnswersSchema>;

export const reviewAnswerSchema = z
  .object({
    status: z.enum(REVIEW_STATUSES),
    /** Nota interna del revisor. No la ve el alumno. */
    nota: z.string().trim().max(2000).optional(),
    /**
     * Respuesta correcta. Obligatoria cuando el estado es CORRECTED: corregir
     * sin escribir la buena no arregla nada, solo marca el problema.
     */
    respuestaCorregida: z.string().trim().min(10).max(8000).optional(),
    /**
     * Pregunta canónica con la que se guardará la corrección. Si se omite se
     * usa la que hizo el alumno. Sirve para generalizar ("cómo instalo el nodo"
     * en vez de "oye no me va la instalación esa que dijiste").
     */
    preguntaCanonica: z.string().trim().min(3).max(500).optional(),
    /**
     * Si true, la corrección vale para todos los cursos del tenant. Para dudas
     * transversales (certificados, facturación, cómo va el aula).
     */
    aplicaATodosLosCursos: z.boolean().optional(),
  })
  .refine((v) => v.status !== 'CORRECTED' || !!v.respuestaCorregida, {
    message: 'Para marcar como corregida hay que escribir la respuesta correcta.',
    path: ['respuestaCorregida'],
  });
export type ReviewAnswerDto = z.infer<typeof reviewAnswerSchema>;

export const upsertCorrectionSchema = z.object({
  pregunta: z.string().trim().min(3).max(500),
  respuesta: z.string().trim().min(10).max(8000),
  /** Null / omitido = vale para todos los cursos del tenant. */
  courseId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
});
export type UpsertCorrectionDto = z.infer<typeof upsertCorrectionSchema>;

export const monthlyReportSchema = z.object({
  /** Mes en formato YYYY-MM. Si se omite, el mes en curso. */
  mes: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Formato esperado YYYY-MM')
    .optional(),
  courseId: z.string().uuid().optional(),
});
export type MonthlyReportDto = z.infer<typeof monthlyReportSchema>;

/** Un intercambio pregunta→respuesta tal y como lo revisa el admin. */
export interface ReviewAnswerView {
  /** ID del mensaje del tutor. Es lo que se revisa. */
  messageId: string;
  conversationId: string;
  question: string;
  answer: string;
  /** Lecciones en las que se apoyó. Vacío = respondió sin respaldo. */
  citations: Array<{ lessonId: string | null; lessonTitle: string | null }>;
  courseId: string;
  courseTitle: string | null;
  /** Quién preguntó. */
  user: { id: string; name: string | null; email: string | null };
  askedAt: string;
  reviewStatus: ReviewStatus;
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string | null } | null;
  reviewNote: string | null;
  /** Corrección asociada, si la respuesta se corrigió. */
  correction: { id: string; question: string; answer: string; active: boolean } | null;
}

export interface ListAnswersResultView {
  items: ReviewAnswerView[];
  total: number;
  page: number;
  pageSize: number;
  /** Cuántas quedan sin revisar en todo el tenant, con los filtros aplicados. */
  pendientes: number;
}

export interface CorrectionView {
  id: string;
  courseId: string | null;
  courseTitle: string | null;
  question: string;
  answer: string;
  active: boolean;
  timesUsed: number;
  authorId: string;
  authorName: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Un tema del informe mensual: varias formulaciones de la misma duda. */
export interface ReportTopicView {
  /** Formulación más representativa del grupo. */
  pregunta: string;
  /** Nº de preguntas del grupo (no de alumnos). */
  veces: number;
  /** Alumnos distintos que lo han preguntado. */
  alumnos: number;
  /** Quiénes, de más a menos veces. */
  quienes: Array<{ id: string; name: string | null; veces: number }>;
  /** Cursos desde los que se preguntó. */
  cursos: Array<{ id: string; title: string | null; veces: number }>;
  /** Respuestas del grupo que salieron sin ninguna cita al material. */
  sinRespaldo: number;
  /** Respuestas del grupo aún sin revisar. */
  pendientesDeRevision: number;
  /** Respuestas del grupo ya corregidas por una persona. */
  corregidas: number;
  /** Ejemplos de otras formulaciones, para entender el grupo. */
  variantes: string[];
  /** Mensajes del tutor del grupo, para saltar a revisarlos. */
  messageIds: string[];
}

export interface MonthlyReportView {
  /** Mes analizado, YYYY-MM. */
  mes: string;
  desde: string;
  hasta: string;
  totalPreguntas: number;
  alumnosActivos: number;
  /** Respuestas sin ninguna cita al material del curso. */
  sinRespaldo: number;
  pendientesDeRevision: number;
  corregidas: number;
  temas: ReportTopicView[];
  /** Alumnos que más preguntan. */
  topAlumnos: Array<{ id: string; name: string | null; veces: number }>;
  /** True si el mes tenía más preguntas de las que se analizan de una vez. */
  truncado: boolean;
}
