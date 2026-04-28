import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import type { LessonType } from './courses';

export type EnrollmentStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export interface Enrollment {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
  status: EnrollmentStatus;
  source: string;
  completionThreshold: number;
  progressPercent: number;
  enrolledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface LessonProgress {
  lessonId: string;
  completed: boolean;
  watchedSeconds: number;
  resumePositionSec: number;
  completedAt: string | null;
}

export interface ProgressResult {
  progress: {
    id: string;
    enrollmentId: string;
    lessonId: string;
    watchedSeconds: number;
    resumePositionSec: number;
    completed: boolean;
  };
  totalLessons: number;
  completedLessons: number;
  progressPercent: number;
}

export interface Invitation {
  id: string;
  tenantId: string;
  courseId: string;
  code: string;
  token: string;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

function bearer(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const learningApi = {
  async listMine(): Promise<Enrollment[]> {
    return apiFetch<Enrollment[]>(
      '/api/v1/modules/learning/me/enrollments',
      { method: 'GET' },
      bearer(),
    );
  },

  async enrollSelf(courseId: string): Promise<Enrollment> {
    return apiFetch<Enrollment>(
      '/api/v1/modules/learning/enrollments/me',
      { method: 'POST', body: JSON.stringify({ courseId }) },
      bearer(),
    );
  },

  async enrollByCode(code: string): Promise<Enrollment> {
    return apiFetch<Enrollment>(
      '/api/v1/modules/learning/enrollments/by-code',
      { method: 'POST', body: JSON.stringify({ code }) },
      bearer(),
    );
  },

  async cancel(enrollmentId: string): Promise<Enrollment> {
    return apiFetch<Enrollment>(
      `/api/v1/modules/learning/enrollments/${enrollmentId}`,
      { method: 'DELETE' },
      bearer(),
    );
  },

  async trackProgress(input: {
    enrollmentId: string;
    lessonId: string;
    watchedSeconds: number;
    resumePositionSec?: number;
    completed?: boolean;
  }): Promise<ProgressResult> {
    return apiFetch<ProgressResult>(
      '/api/v1/modules/learning/progress',
      { method: 'POST', body: JSON.stringify(input) },
      bearer(),
    );
  },

  async listMyProgress(enrollmentId: string): Promise<LessonProgress[]> {
    return apiFetch<LessonProgress[]>(
      `/api/v1/modules/learning/me/enrollments/${enrollmentId}/progress`,
      { method: 'GET' },
      bearer(),
    );
  },

  async listInvitations(courseId: string): Promise<Invitation[]> {
    const params = new URLSearchParams({ courseId });
    return apiFetch<Invitation[]>(
      `/api/v1/modules/learning/invitations?${params}`,
      { method: 'GET' },
      bearer(),
    );
  },

  async createInvitation(input: {
    courseId: string;
    maxUses?: number;
    expiresAt?: string;
  }): Promise<Invitation> {
    return apiFetch<Invitation>(
      '/api/v1/modules/learning/invitations',
      { method: 'POST', body: JSON.stringify(input) },
      bearer(),
    );
  },

  async revokeInvitation(invitationId: string): Promise<void> {
    await apiFetch<{ revoked: boolean }>(
      `/api/v1/modules/learning/invitations/${invitationId}`,
      { method: 'DELETE' },
      bearer(),
    );
  },

  /** HU-FORM-002: lista de alumnos matriculados en un curso. */
  async listEnrollmentsByCourse(
    courseId: string,
    options: { status?: EnrollmentStatus; limit?: number } = {},
  ): Promise<CourseEnrollmentRow[]> {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    return apiFetch<CourseEnrollmentRow[]>(
      `/api/v1/modules/learning/courses/${courseId}/enrollments${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      bearer(),
    );
  },
};

export interface CourseEnrollmentRow {
  enrollmentId: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  userStatus: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED' | null;
  lastLoginAt: string | null;
  status: EnrollmentStatus;
  progressPercent: number;
  enrolledAt: string;
  completedAt: string | null;
  completionThreshold: number;
}

export function enrollmentsToCsv(rows: CourseEnrollmentRow[]): string {
  const escape = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const header = ['email', 'name', 'status', 'progress_percent', 'enrolled_at', 'completed_at'];
  const lines = rows.map((r) =>
    [r.userEmail, r.userName, r.status, r.progressPercent, r.enrolledAt, r.completedAt]
      .map(escape)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

export type { LessonType };
