import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import { ApiHttpError } from './api-client';

export type SessionStatus = 'SCHEDULED' | 'STARTED' | 'ENDED' | 'CANCELLED';

export interface ZoomSession {
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
  /** Solo presente para host/admin. */
  startUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const zoomLiveApi = {
  async list(opts: { courseId?: string; status?: SessionStatus } = {}): Promise<ZoomSession[]> {
    const params = new URLSearchParams();
    if (opts.courseId) params.set('courseId', opts.courseId);
    if (opts.status) params.set('status', opts.status);
    const qs = params.toString();
    return apiFetch<ZoomSession[]>(
      `/api/v1/modules/zoom-live/sessions${qs ? `?${qs}` : ''}`,
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
};
