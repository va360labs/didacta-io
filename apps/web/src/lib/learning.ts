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

  async enrollByAdmin(input: { userId: string; courseId: string }): Promise<Enrollment> {
    return apiFetch<Enrollment>(
      '/api/v1/modules/learning/enrollments',
      { method: 'POST', body: JSON.stringify(input) },
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
};

export type { LessonType };
