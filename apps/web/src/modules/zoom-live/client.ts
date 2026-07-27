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
  }): Promise<ZoomSession> {
    return apiFetch<ZoomSession>(
      '/api/v1/modules/zoom-live/sessions',
      { method: 'POST', body: JSON.stringify(input) },
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
