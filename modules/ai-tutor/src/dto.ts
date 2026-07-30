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
