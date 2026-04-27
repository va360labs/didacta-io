import { z } from 'zod';

/**
 * DTOs y tipos del módulo Zoom Live.
 *
 * Filosofía v0.1:
 *  - El backend es la fuente de la verdad de las sesiones (`mod_zoom_session`).
 *  - La integración real con Zoom API se hace en `ZoomApiClient` (stub por
 *    ahora). El service no acopla a la API: trabaja contra la fila de DB.
 *  - El startUrl/joinUrl los devuelve la API al crear la sesión y se guardan
 *    en columnas. Si no hay credenciales, son URLs `https://stub-zoom/...`
 *    para no romper el flujo de UI en dev.
 */

export const sessionStatusSchema = z.enum(['SCHEDULED', 'STARTED', 'ENDED', 'CANCELLED']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const createSessionSchema = z.object({
  /** UUID del curso al que se vincula. NULL = sesión libre del tenant. */
  courseId: z.string().uuid().nullable().optional(),
  topic: z.string().min(1).max(200),
  /** ISO 8601 con zona. Ej: "2026-05-15T10:00:00-03:00". */
  startTime: z.string().datetime({ offset: true }),
  /** Duración en minutos. Mínimo 15, máximo 480 (8h). */
  durationMinutes: z.number().int().min(15).max(480),
  /** Email del host. Tiene que ser un user del tenant con `zoom.session.write`. */
  hostEmail: z.string().email(),
  /** Timezone IANA. Ej: "America/Argentina/Buenos_Aires". */
  timezone: z.string().min(3).max(64),
  /** Notas o agenda opcional. */
  description: z.string().max(2000).optional(),
});
export type CreateSessionDto = z.infer<typeof createSessionSchema>;

export const updateSessionSchema = z.object({
  topic: z.string().min(1).max(200).optional(),
  startTime: z.string().datetime({ offset: true }).optional(),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  timezone: z.string().min(3).max(64).optional(),
  description: z.string().max(2000).nullable().optional(),
});
export type UpdateSessionDto = z.infer<typeof updateSessionSchema>;

export interface SessionView {
  id: string;
  tenantId: string;
  courseId: string | null;
  topic: string;
  description: string | null;
  status: SessionStatus;
  startTime: string;
  durationMinutes: number;
  timezone: string;
  hostEmail: string;
  zoomMeetingId: string | null;
  joinUrl: string | null;
  /** Solo se devuelve al host/admin. Para alumnos, undefined. */
  startUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}
