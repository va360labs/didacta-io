import { z } from 'zod';

/**
 * Modalidades reconocidas por Fundae para acciones formativas.
 * Fuente: especificación XML de la fundación.
 */
export const modalidadSchema = z.enum(['PRESENCIAL', 'TELEFORMACION', 'MIXTA']);
export type Modalidad = z.infer<typeof modalidadSchema>;

export const actionStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED']);
export type ActionStatus = z.infer<typeof actionStatusSchema>;

export const createActionSchema = z.object({
  /** UUID del curso vinculado (opcional). Si está set, los datos del curso
   * (título, duración) sirven de fuente de verdad para el report. */
  courseId: z.string().uuid().nullable().optional(),
  /** Código interno de la acción formativa Fundae. Máx 25 caracteres. */
  codigoAccion: z.string().min(1).max(25),
  /** Nombre legible de la acción formativa. */
  nombre: z.string().min(1).max(200),
  modalidad: modalidadSchema,
  /** Horas totales de formación (Fundae acepta enteros y medias horas como
   * decimales 0.5). */
  horasFormacion: z.number().positive().max(9999),
  /** Fecha inicio (ISO 8601 date, YYYY-MM-DD). */
  fechaInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD'),
  /** Fecha fin (ISO 8601 date). */
  fechaFin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD'),
  /** Lugar (para PRESENCIAL/MIXTA) o "On-line" para TELEFORMACION. */
  lugar: z.string().max(200).optional(),
  /** CIF/NIF del centro impartidor (opcional, snapshot del tenant). */
  cifCentro: z.string().max(20).optional(),
  /** Notas internas del admin. No van al XML. */
  notas: z.string().max(2000).optional(),
});
export type CreateActionDto = z.infer<typeof createActionSchema>;

export const updateActionSchema = createActionSchema.partial().extend({
  status: actionStatusSchema.optional(),
});
export type UpdateActionDto = z.infer<typeof updateActionSchema>;

export interface ActionView {
  id: string;
  tenantId: string;
  courseId: string | null;
  codigoAccion: string;
  nombre: string;
  modalidad: Modalidad;
  horasFormacion: number;
  fechaInicio: string;
  fechaFin: string;
  lugar: string | null;
  cifCentro: string | null;
  notas: string | null;
  status: ActionStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Bloque/módulo formativo que compone una acción Fundae. Una acción
 * puede tener N bloques cuyas horas suman como mucho `horasFormacion`
 * de la acción (Fundae lo verifica al subir el XML). El `ordinal`
 * define el orden de impartición y es único por acción.
 */
export const createBlockSchema = z.object({
  /** Orden 1..N. Si no se provee, el service lo calcula como max(ordinal)+1. */
  ordinal: z.number().int().min(1).max(99).optional(),
  title: z.string().min(1).max(200),
  hours: z.number().positive().max(9999),
  modalidad: modalidadSchema,
  contenidos: z.string().max(4000).optional(),
});
export type CreateBlockDto = z.infer<typeof createBlockSchema>;

export const updateBlockSchema = z.object({
  ordinal: z.number().int().min(1).max(99).optional(),
  title: z.string().min(1).max(200).optional(),
  hours: z.number().positive().max(9999).optional(),
  modalidad: modalidadSchema.optional(),
  contenidos: z.string().max(4000).optional(),
});
export type UpdateBlockDto = z.infer<typeof updateBlockSchema>;

export interface BlockView {
  id: string;
  actionId: string;
  ordinal: number;
  title: string;
  hours: number;
  modalidad: Modalidad;
  contenidos: string;
  createdAt: string;
  updatedAt: string;
}
