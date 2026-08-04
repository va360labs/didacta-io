/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { ApiHttpError } from '@/lib/api-client';

export type SessionStatus = 'SCHEDULED' | 'STARTED' | 'ENDED' | 'CANCELLED';

export interface ZoomSession {
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
  /** NULL salvo que estés inscrito o seas staff (gating server-side, ADR-017). */
  joinUrl: string | null;
  /** Solo presente para host/admin. */
  startUrl?: string | null;
  /** Mismo gating que joinUrl. */
  recordingUrl: string | null;
  recordingDurationMinutes: number | null;
  registeredCount: number;
  isRegistered: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ZoomSessionRegistration {
  userId: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  registeredAt: string;
}

/** De dónde sale el `attended` de una fila (ADR-018). */
export type AttendanceConfidence = 'ZOOM' | 'PROXY' | 'MANUAL' | 'NONE';

export interface AttendanceRow {
  /** NULL para participantes de Zoom que no casan con ningún miembro. */
  userId: string | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  registered: boolean;
  registeredAt: string | null;
  attended: boolean;
  confidence: AttendanceConfidence;
  minutes: number;
  clickedJoinAt: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  manualPresent: boolean | null;
  zoomName: string | null;
  zoomEmail: string | null;
}

export interface AttendanceReport {
  sessionId: string;
  status: SessionStatus;
  syncedAt: string | null;
  syncError: string | null;
  canSync: boolean;
  registeredCount: number;
  attendedCount: number;
  rows: AttendanceRow[];
}

export type WebhookEventResult = 'OK' | 'IGNORED' | 'ERROR';

export interface ZoomWebhookEventItem {
  id: string;
  eventId: string;
  eventType: string;
  meetingId: string | null;
  sessionId: string | null;
  receivedAt: string;
  result: WebhookEventResult;
  errorMessage: string | null;
}

export interface PaginatedWebhookEvents {
  items: ZoomWebhookEventItem[];
  total: number;
  page: number;
  limit: number;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const zoomLiveApi = {
  async list(
    opts: {
      courseId?: string;
      lessonId?: string;
      status?: SessionStatus;
      /** ISO 8601 con offset — rango por startTime (calendario). */
      from?: string;
      to?: string;
    } = {},
  ): Promise<ZoomSession[]> {
    const params = new URLSearchParams();
    if (opts.courseId) params.set('courseId', opts.courseId);
    if (opts.lessonId) params.set('lessonId', opts.lessonId);
    if (opts.status) params.set('status', opts.status);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    const qs = params.toString();
    return apiFetch<ZoomSession[]>(
      `/api/v1/modules/zoom-live/sessions${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  /** Inscripción a la sesión. Devuelve la vista ya con joinUrl visible. */
  async register(id: string): Promise<ZoomSession> {
    return apiFetch<ZoomSession>(
      `/api/v1/modules/zoom-live/sessions/${id}/register`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  async unregister(id: string): Promise<{ unregistered: boolean }> {
    return apiFetch<{ unregistered: boolean }>(
      `/api/v1/modules/zoom-live/sessions/${id}/unregister`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  /**
   * Sella la entrada del usuario y devuelve el `joinUrl` (ADR-018). La UI la
   * dispara al pulsar "Unirme" sin esperar la respuesta: la pestaña de Zoom se
   * abre nativamente y aquí solo queda constancia de que entró.
   */
  async join(id: string): Promise<{ joinUrl: string }> {
    return apiFetch<{ joinUrl: string }>(
      `/api/v1/modules/zoom-live/sessions/${id}/join`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  /** Informe de asistencia (solo formador/admin). */
  async getAttendance(id: string): Promise<AttendanceReport> {
    return apiFetch<AttendanceReport>(
      `/api/v1/modules/zoom-live/sessions/${id}/attendance`,
      { method: 'GET' },
      withAuth(),
    );
  },

  /** Fuerza la reconciliación contra Zoom (solo formador/admin). */
  async syncAttendance(id: string): Promise<AttendanceReport> {
    return apiFetch<AttendanceReport>(
      `/api/v1/modules/zoom-live/sessions/${id}/attendance/sync`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  /** Override manual de asistencia. `present: null` lo quita. */
  async setManualAttendance(
    id: string,
    userId: string,
    present: boolean | null,
  ): Promise<AttendanceReport> {
    return apiFetch<AttendanceReport>(
      `/api/v1/modules/zoom-live/sessions/${id}/attendance/${userId}`,
      { method: 'PUT', body: JSON.stringify({ present }) },
      withAuth(),
    );
  },

  /** Roster de inscritos (solo formador/admin). */
  async listRegistrations(id: string): Promise<ZoomSessionRegistration[]> {
    return apiFetch<ZoomSessionRegistration[]>(
      `/api/v1/modules/zoom-live/sessions/${id}/registrations`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async get(id: string): Promise<ZoomSession> {
    return apiFetch<ZoomSession>(
      `/api/v1/modules/zoom-live/sessions/${id}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async create(input: {
    courseId?: string | null;
    lessonId?: string | null;
    topic: string;
    startTime: string;
    durationMinutes: number;
    hostEmail: string;
    timezone: string;
    description?: string;
    /** Publica un anuncio de la clase en el feed de la comunidad. */
    announce?: boolean;
  }): Promise<ZoomSession> {
    return apiFetch<ZoomSession>(
      '/api/v1/modules/zoom-live/sessions',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  /**
   * Edita una sesión SCHEDULED/STARTED. Solo viajan los campos que la API
   * admite cambiar: el host, el curso y la lección quedan fijos desde la
   * creación (cambiarlos implicaría recrear el meeting en Zoom).
   */
  async update(
    id: string,
    input: {
      topic?: string;
      startTime?: string;
      durationMinutes?: number;
      timezone?: string;
      description?: string | null;
      /** Publica el anuncio en la comunidad si aún no existe. */
      announce?: boolean;
    },
  ): Promise<ZoomSession> {
    return apiFetch<ZoomSession>(
      `/api/v1/modules/zoom-live/sessions/${id}`,
      { method: 'PUT', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async cancel(id: string): Promise<void> {
    await apiFetch<{ cancelled: true }>(
      `/api/v1/modules/zoom-live/sessions/${id}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },

  async testCredentials(): Promise<{ kind: 'real' | 'stub'; accountId: string }> {
    return apiFetch<{ kind: 'real' | 'stub'; accountId: string }>(
      '/api/v1/modules/zoom-live/test-credentials',
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  async upsertCredentials(value: {
    accountId: string;
    clientId: string;
    clientSecret: string;
    /** Vacío conserva el guardado previo (merge del backend, igual que clientSecret). */
    webhookSecret?: string;
  }): Promise<void> {
    await apiFetch(
      '/api/v1/tenant-settings/zoom-live/credentials',
      { method: 'PUT', body: JSON.stringify({ value, isSecret: true }) },
      withAuth(),
    );
  },

  async removeCredentials(): Promise<void> {
    await apiFetch(
      '/api/v1/tenant-settings/zoom-live/credentials',
      { method: 'DELETE' },
      withAuth(),
    );
  },

  async listWebhookEvents(
    opts: {
      eventType?: string;
      result?: WebhookEventResult;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<PaginatedWebhookEvents> {
    const params = new URLSearchParams();
    if (opts.eventType) params.set('eventType', opts.eventType);
    if (opts.result) params.set('result', opts.result);
    if (opts.page) params.set('page', String(opts.page));
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return apiFetch<PaginatedWebhookEvents>(
      `/api/v1/modules/zoom-live/webhook-events${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      withAuth(),
    );
  },
};
