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
  /** UUID de una lección concreta del curso. Si está set, courseId también
   * tiene que estar set y la lección debe pertenecer a ese curso. */
  lessonId: z.string().uuid().nullable().optional(),
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

/**
 * Schema mínimo del payload de webhook que nos interesa procesar.
 * Zoom envía mucho más, pero solo extraemos lo que afecta al status.
 *
 * Eventos soportados v0.1:
 *  - `meeting.started` → `STARTED`
 *  - `meeting.ended` → `ENDED`
 *
 * Otros eventos (`meeting.participant_joined`, `recording.completed`,
 * etc.) se persisten como `IGNORED` y no provocan cambios; los
 * dejamos en la tabla por trazabilidad y para iteraciones futuras.
 */
export const webhookEventSchema = z.object({
  /**
   * UUID del evento generado por Zoom. Usado para idempotencia (Zoom
   * reintenta hasta 3 veces si no recibimos 2xx en 3s).
   */
  event_id: z.string().min(1),
  event: z.string().min(1),
  /** Timestamp epoch ms. */
  event_ts: z.number().int().optional(),
  payload: z
    .object({
      account_id: z.string().optional(),
      object: z
        .object({
          /** Numérico en JSON; Zoom usa number pero serializamos como string. */
          id: z.union([z.string(), z.number()]).optional(),
          uuid: z.string().optional(),
          host_email: z.string().optional(),
          start_time: z.string().optional(),
          end_time: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type ZoomWebhookEvent = z.infer<typeof webhookEventSchema>;

export interface SessionView {
  id: string;
  tenantId: string;
  courseId: string | null;
  lessonId: string | null;
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
