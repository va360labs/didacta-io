import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export type QuestionType =
  | 'SINGLE_CHOICE'
  | 'MULTIPLE_CHOICE'
  | 'TRUE_FALSE'
  | 'FILL_IN_BLANK'
  | 'SHORT_ANSWER'
  | 'LONG_ANSWER';
export type QuizStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type AttemptStatus =
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'PENDING_REVIEW'
  | 'GRADED'
  | 'EXPIRED'
  | 'ABANDONED';

export interface QuizSummary {
  id: string;
  tenantId: string;
  lessonId: string | null;
  title: string;
  description: string | null;
  status: QuizStatus;
  passThreshold: number;
  maxAttempts: number | null;
  timeLimitMinutes: number | null;
  shuffleQuestions: boolean;
  showFeedback: boolean;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface FormadorOption {
  id: string;
  label: string;
  isCorrect: boolean;
  position: number;
}

export interface FormadorQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  feedback: string | null;
  position: number;
  points: number;
  options: FormadorOption[];
  acceptedAnswers: string[];
}

export interface QuizFormadorView extends QuizSummary {
  questions: FormadorQuestion[];
}

export interface AlumnoOption {
  id: string;
  label: string;
  position: number;
}

export interface AlumnoQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  position: number;
  points: number;
  options: AlumnoOption[];
}

export interface QuizAlumnoView {
  id: string;
  title: string;
  description: string | null;
  passThreshold: number;
  maxAttempts: number | null;
  timeLimitMinutes: number | null;
  shuffleQuestions: boolean;
  questions: AlumnoQuestion[];
}

export interface AttemptSummary {
  id: string;
  tenantId: string;
  quizId: string;
  userId: string;
  enrollmentId: string | null;
  lessonId: string | null;
  status: AttemptStatus;
  scoreEarned: number | null;
  scoreMax: number | null;
  scorePercent: number | null;
  passed: boolean | null;
  startedAt: string;
  expiresAt: string | null;
  submittedAt: string | null;
  gradedAt?: string | null;
  gradedById?: string | null;
}

export interface AttemptDetail extends AttemptSummary {
  answers: {
    id: string;
    questionId: string;
    selectedOptionIds: string[];
    isCorrect: boolean;
    scoreEarned: number;
  }[];
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const assessmentsApi = {
  // -------------------- formador --------------------

  async createQuiz(input: {
    lessonId?: string;
    title: string;
    description?: string;
    passThreshold?: number;
    maxAttempts?: number;
    timeLimitMinutes?: number;
    shuffleQuestions?: boolean;
    showFeedback?: boolean;
  }): Promise<QuizSummary> {
    return apiFetch<QuizSummary>(
      '/api/v1/modules/assessments/quizzes',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async getQuizForFormador(id: string): Promise<QuizFormadorView> {
    return apiFetch<QuizFormadorView>(
      `/api/v1/modules/assessments/quizzes/${id}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async updateQuiz(
    id: string,
    input: Partial<{
      lessonId: string;
      title: string;
      description: string;
      passThreshold: number;
      maxAttempts: number;
      timeLimitMinutes: number;
      shuffleQuestions: boolean;
      showFeedback: boolean;
    }>,
  ): Promise<QuizSummary> {
    return apiFetch<QuizSummary>(
      `/api/v1/modules/assessments/quizzes/${id}`,
      { method: 'PUT', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async addQuestion(
    quizId: string,
    input: {
      type: QuestionType;
      prompt: string;
      feedback?: string;
      points?: number;
      options?: { label: string; isCorrect: boolean }[];
      acceptedAnswers?: string[];
    },
  ): Promise<FormadorQuestion> {
    return apiFetch<FormadorQuestion>(
      `/api/v1/modules/assessments/quizzes/${quizId}/questions`,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async deleteQuestion(quizId: string, questionId: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/modules/assessments/quizzes/${quizId}/questions/${questionId}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },

  async publishQuiz(id: string): Promise<QuizSummary> {
    return apiFetch<QuizSummary>(
      `/api/v1/modules/assessments/quizzes/${id}/publish`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },

  // -------------------- alumno --------------------

  async preview(id: string): Promise<QuizAlumnoView> {
    return apiFetch<QuizAlumnoView>(
      `/api/v1/modules/assessments/quizzes/${id}/preview`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async startAttempt(input: {
    quizId: string;
    enrollmentId?: string;
    lessonId?: string;
  }): Promise<AttemptSummary> {
    return apiFetch<AttemptSummary>(
      '/api/v1/modules/assessments/attempts',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async submitAttempt(
    attemptId: string,
    answers: { questionId: string; selectedOptionIds?: string[]; textAnswer?: string }[],
  ): Promise<AttemptSummary> {
    return apiFetch<AttemptSummary>(
      `/api/v1/modules/assessments/attempts/${attemptId}/submit`,
      { method: 'POST', body: JSON.stringify({ answers }) },
      withAuth(),
    );
  },

  async getAttempt(id: string): Promise<AttemptDetail> {
    return apiFetch<AttemptDetail>(
      `/api/v1/modules/assessments/attempts/${id}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async listAttempts(quizId: string): Promise<AttemptSummary[]> {
    return apiFetch<AttemptSummary[]>(
      `/api/v1/modules/assessments/attempts?quizId=${encodeURIComponent(quizId)}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  // -------------------- formador (corrección manual) --------------------

  async listPendingReview(): Promise<
    Array<
      AttemptSummary & {
        quiz: { id: string; title: string; lessonId: string | null };
        answers: { id: string; questionId: string }[];
      }
    >
  > {
    return apiFetch('/api/v1/modules/assessments/attempts/pending', { method: 'GET' }, withAuth());
  },

  async gradeAttempt(
    attemptId: string,
    grades: { questionId: string; scoreEarned: number; feedback?: string }[],
  ): Promise<AttemptSummary> {
    return apiFetch<AttemptSummary>(
      `/api/v1/modules/assessments/attempts/${attemptId}/grade`,
      { method: 'POST', body: JSON.stringify({ grades }) },
      withAuth(),
    );
  },
};
