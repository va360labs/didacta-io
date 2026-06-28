import { apiFetchAuth } from './_runtime';

export type SessionStatus = 'SCHEDULED' | 'STARTED' | 'ENDED' | 'CANCELLED';

export interface ZoomSession {
  id: string;
  topic: string;
  description: string | null;
  status: SessionStatus;
  startTime: string;
  durationMinutes: number;
  timezone: string;
  hostEmail: string;
  joinUrl: string | null;
  startUrl?: string | null;
}

export interface CreateSessionInput {
  topic: string;
  startTime: string;
  durationMinutes: number;
  hostEmail: string;
  timezone: string;
  description?: string;
  courseId?: string;
  lessonId?: string;
}

/** Curso/lección leídos vía la API pública de mod.courses (ADR-016: read cross-module). */
export interface CourseLite {
  id: string;
  title: string;
}
export interface CourseDetailLite {
  modules: Array<{ title: string; lessons: Array<{ id: string; title: string }> }>;
}

export const zoomLiveUiApi = {
  // ── Sesiones ───────────────────────────────────────────────────────────────
  async listSessions(): Promise<ZoomSession[]> {
    return apiFetchAuth<ZoomSession[]>('/api/v1/modules/zoom-live/sessions', { method: 'GET' });
  },

  async createSession(input: CreateSessionInput): Promise<ZoomSession> {
    return apiFetchAuth<ZoomSession>('/api/v1/modules/zoom-live/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async cancelSession(id: string): Promise<void> {
    await apiFetchAuth(`/api/v1/modules/zoom-live/sessions/${id}`, { method: 'DELETE' });
  },

  // ── Cursos (API pública de mod.courses) ──────────────────────────────────────
  async listPublishedCourses(): Promise<CourseLite[]> {
    return apiFetchAuth<CourseLite[]>('/api/v1/modules/courses?status=PUBLISHED', {
      method: 'GET',
    });
  },

  async getCourseDetail(id: string): Promise<CourseDetailLite> {
    return apiFetchAuth<CourseDetailLite>(`/api/v1/modules/courses/${id}`, { method: 'GET' });
  },

  // ── Credenciales (surface admin) ─────────────────────────────────────────────
  async testCredentials(): Promise<{ kind: 'real' | 'stub'; accountId: string }> {
    return apiFetchAuth<{ kind: 'real' | 'stub'; accountId: string }>(
      '/api/v1/modules/zoom-live/test-credentials',
      { method: 'POST', body: '{}' },
    );
  },

  async upsertCredentials(value: {
    accountId: string;
    clientId: string;
    clientSecret: string;
  }): Promise<void> {
    await apiFetchAuth('/api/v1/tenant-settings/zoom-live/credentials', {
      method: 'PUT',
      body: JSON.stringify({ value, isSecret: true }),
    });
  },

  async removeCredentials(): Promise<void> {
    await apiFetchAuth('/api/v1/tenant-settings/zoom-live/credentials', {
      method: 'DELETE',
    });
  },
};
