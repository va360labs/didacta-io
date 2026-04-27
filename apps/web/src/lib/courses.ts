import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export type CourseStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type LessonType = 'VIDEO' | 'HTML' | 'PDF' | 'TEXT' | 'QUIZ' | 'SCORM';

export interface Course {
  id: string;
  tenantId: string;
  slug: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  language: string;
  estimatedMinutes: number | null;
  status: CourseStatus;
  category: string | null;
  certificateTemplateId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CourseLesson {
  id: string;
  moduleId: string;
  type: LessonType;
  title: string;
  position: number;
  durationMinutes: number | null;
  content?: Record<string, unknown>;
}

export interface CourseModule {
  id: string;
  courseId: string;
  title: string;
  description: string | null;
  position: number;
  lessons: CourseLesson[];
}

export interface CourseDetail extends Course {
  modules: CourseModule[];
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const coursesApi = {
  async list(opts: { status?: CourseStatus } = {}): Promise<Course[]> {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    const path = `/api/v1/modules/courses${params.toString() ? `?${params}` : ''}`;
    return apiFetch<Course[]>(path, { method: 'GET' }, withAuth());
  },

  async get(id: string): Promise<CourseDetail> {
    return apiFetch<CourseDetail>(`/api/v1/modules/courses/${id}`, { method: 'GET' }, withAuth());
  },

  async create(input: {
    slug: string;
    title: string;
    description?: string;
    language?: string;
    estimatedMinutes?: number;
    category?: string;
  }): Promise<Course> {
    return apiFetch<Course>(
      '/api/v1/modules/courses',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async addModule(
    courseId: string,
    input: { title: string; description?: string },
  ): Promise<CourseModule> {
    return apiFetch<CourseModule>(
      `/api/v1/modules/courses/${courseId}/modules`,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async addLesson(
    moduleId: string,
    input: {
      type: LessonType;
      title: string;
      content?: Record<string, unknown>;
      durationMinutes?: number;
    },
  ): Promise<CourseLesson> {
    return apiFetch<CourseLesson>(
      `/api/v1/modules/courses/modules/${moduleId}/lessons`,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async updateLesson(
    lessonId: string,
    input: {
      title?: string;
      content?: Record<string, unknown>;
      durationMinutes?: number | null;
    },
  ): Promise<CourseLesson> {
    return apiFetch<CourseLesson>(
      `/api/v1/modules/courses/lessons/${lessonId}`,
      { method: 'PUT', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async publish(courseId: string): Promise<Course> {
    return apiFetch<Course>(
      `/api/v1/modules/courses/${courseId}/publish`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  async archive(courseId: string): Promise<Course> {
    return apiFetch<Course>(
      `/api/v1/modules/courses/${courseId}/archive`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  async moveLesson(lessonId: string, direction: 'up' | 'down'): Promise<CourseLesson> {
    return apiFetch<CourseLesson>(
      `/api/v1/modules/courses/lessons/${lessonId}/move`,
      { method: 'POST', body: JSON.stringify({ direction }) },
      withAuth(),
    );
  },

  async deleteModule(moduleId: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/modules/courses/modules/${moduleId}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },

  async deleteLesson(lessonId: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/modules/courses/lessons/${lessonId}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },

  async update(
    courseId: string,
    input: {
      title?: string;
      description?: string | null;
      category?: string | null;
      estimatedMinutes?: number | null;
      certificateTemplateId?: string | null;
    },
  ): Promise<Course> {
    return apiFetch<Course>(
      `/api/v1/modules/courses/${courseId}`,
      { method: 'PUT', body: JSON.stringify(input) },
      withAuth(),
    );
  },
};
