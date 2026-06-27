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

export type LessonCommentStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface LessonComment {
  id: string;
  tenantId: string;
  lessonId: string;
  courseId: string;
  authorId: string;
  authorDisplayName: string | null;
  body: string;
  status: LessonCommentStatus;
  reviewedById: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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

export interface Competency {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  sortOrder: number;
}

export interface CourseCompetency {
  competencyId: string;
  name: string;
  weight: number;
}

export interface MyCompetencies {
  competencies: Array<{ id: string; name: string; score: number }>;
  globalScore: number | null;
  globalLevel: string | null;
}

export const learningApi = {
  async listMine(): Promise<Enrollment[]> {
    return apiFetch<Enrollment[]>(
      '/api/v1/modules/learning/me/enrollments',
      { method: 'GET' },
      bearer(),
    );
  },

  /** Stats de aprendizaje para el perfil: cursos completados + segundos vistos. */
  async getMyStats(): Promise<{ completedCourses: number; trainingSeconds: number }> {
    return apiFetch<{ completedCourses: number; trainingSeconds: number }>(
      '/api/v1/modules/learning/me/stats',
      { method: 'GET' },
      bearer(),
    );
  },

  // -------------------- Competencias --------------------
  async getMyCompetencies(): Promise<MyCompetencies> {
    return apiFetch<MyCompetencies>(
      '/api/v1/modules/learning/me/competencies',
      { method: 'GET' },
      bearer(),
    );
  },
  async listCompetencies(): Promise<Competency[]> {
    return apiFetch<Competency[]>(
      '/api/v1/modules/learning/competencies',
      { method: 'GET' },
      bearer(),
    );
  },
  async createCompetency(input: {
    name: string;
    description?: string | null;
    sortOrder?: number;
  }): Promise<Competency> {
    return apiFetch<Competency>(
      '/api/v1/modules/learning/competencies',
      { method: 'POST', body: JSON.stringify(input) },
      bearer(),
    );
  },
  async deleteCompetency(id: string): Promise<{ ok: true }> {
    return apiFetch<{ ok: true }>(
      `/api/v1/modules/learning/competencies/${id}`,
      { method: 'DELETE' },
      bearer(),
    );
  },
  async getCourseCompetencies(courseId: string): Promise<CourseCompetency[]> {
    return apiFetch<CourseCompetency[]>(
      `/api/v1/modules/learning/courses/${courseId}/competencies`,
      { method: 'GET' },
      bearer(),
    );
  },
  async setCourseCompetencies(
    courseId: string,
    items: Array<{ competencyId: string; weight?: number }>,
  ): Promise<CourseCompetency[]> {
    return apiFetch<CourseCompetency[]>(
      `/api/v1/modules/learning/courses/${courseId}/competencies`,
      { method: 'PUT', body: JSON.stringify({ items }) },
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

  async listLessonComments(lessonId: string): Promise<LessonComment[]> {
    return apiFetch<LessonComment[]>(
      `/api/v1/modules/learning/lessons/${lessonId}/comments`,
      { method: 'GET' },
      bearer(),
    );
  },

  async createLessonComment(
    lessonId: string,
    input: { courseId: string; body: string },
  ): Promise<LessonComment> {
    return apiFetch<LessonComment>(
      `/api/v1/modules/learning/lessons/${lessonId}/comments`,
      { method: 'POST', body: JSON.stringify(input) },
      bearer(),
    );
  },

  async listPendingComments(courseId: string): Promise<LessonComment[]> {
    return apiFetch<LessonComment[]>(
      `/api/v1/modules/learning/courses/${courseId}/comments/pending`,
      { method: 'GET' },
      bearer(),
    );
  },

  async approveLessonComment(commentId: string): Promise<LessonComment> {
    return apiFetch<LessonComment>(
      `/api/v1/modules/learning/comments/${commentId}/approve`,
      { method: 'POST', body: '{}' },
      bearer(),
    );
  },

  async rejectLessonComment(commentId: string, reason?: string): Promise<LessonComment> {
    return apiFetch<LessonComment>(
      `/api/v1/modules/learning/comments/${commentId}/reject`,
      { method: 'POST', body: JSON.stringify({ ...(reason ? { reason } : {}) }) },
      bearer(),
    );
  },

  async deleteLessonComment(commentId: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/modules/learning/comments/${commentId}`,
      { method: 'DELETE' },
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

  /** HU-FORM: detalle del progreso (tiempo visto por lección) de un alumno en un curso. */
  async getEnrollmentProgressDetail(
    courseId: string,
    enrollmentId: string,
  ): Promise<EnrollmentProgressDetail> {
    return apiFetch<EnrollmentProgressDetail>(
      `/api/v1/modules/learning/courses/${courseId}/enrollments/${enrollmentId}/progress`,
      { method: 'GET' },
      bearer(),
    );
  },
};

/** Progreso de una lección concreta dentro del detalle de un alumno (vista formador). */
export interface StudentLessonProgress {
  lessonId: string;
  lessonTitle: string;
  type: LessonType;
  durationMinutes: number | null;
  watchedSeconds: number;
  resumePositionSec: number;
  completed: boolean;
  completedAt: string | null;
  lastAccessedAt: string | null;
}

/** Módulo del curso con sus lecciones y el progreso del alumno. */
export interface StudentProgressModule {
  moduleId: string;
  moduleTitle: string;
  lessons: StudentLessonProgress[];
}

/** Detalle del progreso de un alumno en un curso (tiempo visto por lección). */
export interface EnrollmentProgressDetail {
  enrollmentId: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'PAUSED';
  progressPercent: number;
  totalWatchedSeconds: number;
  lessonsCompleted: number;
  lessonsTotal: number;
  modules: StudentProgressModule[];
}

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
