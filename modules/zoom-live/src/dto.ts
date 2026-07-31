/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
  /**
   * Intención de quien crea la clase de anunciarla públicamente. El módulo no
   * sabe QUIÉN la anuncia ni CÓMO: solo la propaga en `zoom.session.created`
   * para que el host componga (ADR-016). Por defecto no se anuncia, así que
   * una clase de prueba nunca acaba publicada por descuido.
   */
  announce: z.boolean().optional(),
});
export type CreateSessionDto = z.infer<typeof createSessionSchema>;

export const updateSessionSchema = z.object({
  topic: z.string().min(1).max(200).optional(),
  startTime: z.string().datetime({ offset: true }).optional(),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  timezone: z.string().min(3).max(64).optional(),
  description: z.string().max(2000).nullable().optional(),
  /**
   * Intención de anunciar la clase, igual que en la creación: permite publicar
   * en la comunidad una clase que se creó sin anunciar. Si ya estaba anunciada
   * no duplica nada — quien consume el evento es idempotente.
   */
  announce: z.boolean().optional(),
});
export type UpdateSessionDto = z.infer<typeof updateSessionSchema>;

/**
 * Schema mínimo del payload de webhook que nos interesa procesar.
 * Zoom envía mucho más, pero solo extraemos lo que afecta al status
 * o la grabación.
 *
 * Eventos con efecto:
 *  - `meeting.started` → `STARTED`
 *  - `meeting.ended` → `ENDED`
 *  - `recording.completed` → guarda `recordingUrl` + `recordingDurationMinutes`
 *
 * Otros eventos (`meeting.participant_joined`, etc.) se persisten como
 * `IGNORED` y no provocan cambios; los dejamos en la tabla por trazabilidad.
 * La asistencia NO se construye con esos eventos sino reconciliando contra
 * la Report API al terminar la sesión (ADR-018): un `participant_joined`
 * perdido dejaría el registro incompleto para siempre.
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
          /**
           * Solo presente en `recording.completed`. URL pública/compartida
           * para acceder al video desde el portal de Zoom (requiere passcode
           * si está configurado).
           */
          share_url: z.string().optional(),
          /**
           * Duración total del meeting según el reporte de grabación
           * (en minutos). Zoom puede reportar 0 si fue cortado abruptamente.
           */
          duration: z.number().int().nonnegative().optional(),
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
  /**
   * ADR-017: NULL salvo que el viewer esté inscrito a la sesión o sea
   * staff (host/admin). El gating es server-side — la UI nunca es la
   * única barrera.
   */
  joinUrl: string | null;
  /** Solo se devuelve al host/admin. Para alumnos, undefined. */
  startUrl?: string | null;
  /**
   * URL de grabación (Zoom share_url). NULL hasta que llega el webhook —
   * y NULL también para viewers no inscritos (mismo gating que joinUrl).
   */
  recordingUrl: string | null;
  /** Duración del meeting reportada en `recording.completed` (minutos). */
  recordingDurationMinutes: number | null;
  /** Nº de miembros inscritos a la sesión. */
  registeredCount: number;
  /** ¿El viewer actual está inscrito? false cuando no hay viewer. */
  isRegistered: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Identidad del usuario que consulta sesiones. Decide el gating de
 * `joinUrl`/`recordingUrl` (inscrito o staff) y el flag `isRegistered`.
 */
export interface SessionViewer {
  userId: string;
  /** true para super_admin / tenant_admin / formador. */
  isStaff: boolean;
}

/** Fila del roster de inscritos (solo staff). */
export interface RegistrationView {
  userId: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  registeredAt: string;
}

/**
 * De dónde sale el valor de `attended` (ADR-018). Se expone siempre para no
 * presentar nunca una evidencia débil como si fuera confirmación de Zoom:
 *  - `ZOOM`: la sesión se reconcilió contra Zoom; `attended` es lo que Zoom dice.
 *  - `PROXY`: solo sabemos que pulsó "Unirme" en Didacta.
 *  - `MANUAL`: un formador lo marcó a mano (pisa todo lo demás).
 *  - `NONE`: no hay ninguna evidencia.
 */
export type AttendanceConfidence = 'ZOOM' | 'PROXY' | 'MANUAL' | 'NONE';

/** Fila del informe de asistencia (solo staff). */
export interface AttendanceView {
  /** NULL para participantes de Zoom que no casan con ningún miembro. */
  userId: string | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** ¿Estaba inscrito a la clase? Un asistente puede no haberse inscrito. */
  registered: boolean;
  registeredAt: string | null;
  /** La respuesta a "¿asistió?". Derivada, nunca almacenada. */
  attended: boolean;
  confidence: AttendanceConfidence;
  /** Minutos dentro de la sala. 0 si Zoom no reporta duración. */
  minutes: number;
  clickedJoinAt: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  /** Override del formador (null = sin tocar). */
  manualPresent: boolean | null;
  /** Identidad tal cual la reportó Zoom (útil en filas sin `userId`). */
  zoomName: string | null;
  zoomEmail: string | null;
}

export interface AttendanceReport {
  sessionId: string;
  status: SessionStatus;
  /** ISO de la última reconciliación con Zoom. NULL = nunca. */
  syncedAt: string | null;
  /** Motivo del último fallo del pull (típicamente falta de scope). */
  syncError: string | null;
  /** ¿Tiene sentido ofrecer el botón "Sincronizar con Zoom"? */
  canSync: boolean;
  registeredCount: number;
  attendedCount: number;
  rows: AttendanceView[];
}

export const setManualAttendanceSchema = z.object({
  /** true = presente, false = ausente, null = quitar el override. */
  present: z.boolean().nullable(),
});
export type SetManualAttendanceDto = z.infer<typeof setManualAttendanceSchema>;

/** Un participante tal y como lo devuelve la API de Zoom. */
export interface ZoomParticipantRecord {
  /** `user_id` del participante dentro del meeting. */
  participantId: string | null;
  name: string | null;
  email: string | null;
  joinTime: string | null;
  leaveTime: string | null;
  /** Zoom lo reporta en segundos; NULL en el fallback `past_meetings`. */
  durationSeconds: number | null;
}

export interface ZoomParticipantsResult {
  participants: ZoomParticipantRecord[];
  /**
   * `REPORT` = Report API (con tiempos y duración).
   * `PAST_MEETING` = fallback sin duración: sabemos QUIÉN entró, no cuánto.
   */
  source: 'REPORT' | 'PAST_MEETING';
}

/**
 * Vista paginada de eventos webhook recibidos. Sirve al endpoint admin
 * `/modules/zoom-live/webhook-events` para QA/debugging.
 */
export const listWebhookEventsQuerySchema = z.object({
  eventType: z.string().min(1).max(80).optional(),
  result: z.enum(['OK', 'IGNORED', 'ERROR']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListWebhookEventsQuery = z.infer<typeof listWebhookEventsQuerySchema>;

export interface WebhookEventView {
  id: string;
  eventId: string;
  eventType: string;
  meetingId: string | null;
  sessionId: string | null;
  receivedAt: string;
  result: 'OK' | 'IGNORED' | 'ERROR';
  errorMessage: string | null;
}

export interface PaginatedWebhookEvents {
  items: WebhookEventView[];
  total: number;
  page: number;
  limit: number;
}
