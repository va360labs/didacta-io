/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

export interface CitationView {
  lessonId: string;
  lessonTitle: string | null;
  chunkOrdinal: number;
  snippet: string;
  /** Segundo del vídeo donde empieza lo citado, si la transcripción lo traía. */
  startSeconds: number | null;
}

export interface AskResponseView {
  answer: string;
  citations: CitationView[];
  conversationId: string;
  tokensUsed: { input: number; output: number };
  quota: { used: number; limit: number; remaining: number };
}

export interface IndexCourseResultView {
  courseId: string;
  lessonsProcessed: number;
  chunksGenerated: number;
  tokensUsed: number;
  durationMs: number;
}

export interface ProviderCatalogEntry {
  id: string;
  capabilities: Array<'chat' | 'embed'>;
}

export interface TenantProviderConfig {
  id: string;
  purpose: 'chat' | 'embed';
  provider: string;
  model: string;
  baseUrl: string | null;
  enabled: boolean;
  notas: string | null;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProviderInput {
  provider: string;
  model?: string;
  apiKey: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  enabled?: boolean;
  notas?: string;
}

function bearer(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

export const aiTutorApi = {
  /** El alumno (o cualquier usuario autenticado) pregunta al tutor del curso. */
  async ask(
    courseId: string,
    input: {
      question: string;
      conversationId?: string;
      topK?: number;
      /** Lección que está viendo: prioriza sus fragmentos y sitúa la duda. */
      lessonId?: string;
      /** Segundo del vídeo en el que va. */
      positionSeconds?: number;
    },
  ): Promise<AskResponseView> {
    return apiFetch<AskResponseView>(
      `/api/v1/modules/ai-tutor/courses/${courseId}/ask`,
      { method: 'POST', body: JSON.stringify(input) },
      bearer(),
    );
  },

  /** Re-indexación manual del curso. Solo admin. */
  async reindex(courseId: string, force = false): Promise<IndexCourseResultView> {
    return apiFetch<IndexCourseResultView>(
      `/api/v1/admin/ai-tutor/courses/${courseId}/index`,
      { method: 'POST', body: JSON.stringify({ force }) },
      bearer(),
    );
  },

  /**
   * Re-indexa TODOS los cursos publicados del tenant (backfill). Solo admin.
   * Útil para cursos publicados antes de configurar el proveedor de IA.
   */
  async reindexAll(): Promise<ReindexAllResultView> {
    return apiFetch<ReindexAllResultView>(
      '/api/v1/admin/ai-tutor/reindex-all',
      { method: 'POST', body: JSON.stringify({}) },
      bearer(),
    );
  },
};

export interface ReindexAllResultView {
  total: number;
  indexed: number;
  failed: number;
  results: Array<{ courseId: string; ok: boolean; error?: string }>;
}

// ─── Revisión de respuestas del tutor (panel admin) ─────────────────────────

export type ReviewStatus = 'PENDING' | 'OK' | 'CORRECTED';

export interface ReviewAnswerView {
  messageId: string;
  conversationId: string;
  question: string;
  answer: string;
  citations: Array<{ lessonId: string | null; lessonTitle: string | null }>;
  courseId: string;
  courseTitle: string | null;
  user: { id: string; name: string | null; email: string | null };
  askedAt: string;
  reviewStatus: ReviewStatus;
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string | null } | null;
  reviewNote: string | null;
  correction: { id: string; question: string; answer: string; active: boolean } | null;
}

export interface ListAnswersResultView {
  items: ReviewAnswerView[];
  total: number;
  page: number;
  pageSize: number;
  pendientes: number;
}

export interface CorrectionView {
  id: string;
  courseId: string | null;
  courseTitle: string | null;
  question: string;
  answer: string;
  active: boolean;
  timesUsed: number;
  authorId: string;
  authorName: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportTopicView {
  pregunta: string;
  veces: number;
  alumnos: number;
  quienes: Array<{ id: string; name: string | null; veces: number }>;
  cursos: Array<{ id: string; title: string | null; veces: number }>;
  sinRespaldo: number;
  pendientesDeRevision: number;
  corregidas: number;
  variantes: string[];
  messageIds: string[];
}

export interface MonthlyReportView {
  mes: string;
  desde: string;
  hasta: string;
  totalPreguntas: number;
  alumnosActivos: number;
  sinRespaldo: number;
  pendientesDeRevision: number;
  corregidas: number;
  temas: ReportTopicView[];
  topAlumnos: Array<{ id: string; name: string | null; veces: number }>;
  truncado: boolean;
}

export interface ListAnswersFilters {
  courseId?: string;
  status?: ReviewStatus;
  soloSinCitas?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface ReviewAnswerInput {
  status: ReviewStatus;
  nota?: string;
  respuestaCorregida?: string;
  preguntaCanonica?: string;
  aplicaATodosLosCursos?: boolean;
}

export interface UpsertCorrectionInput {
  pregunta: string;
  respuesta: string;
  courseId?: string | null;
  active?: boolean;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const aiTutorReviewApi = {
  async listAnswers(filters: ListAnswersFilters = {}): Promise<ListAnswersResultView> {
    return apiFetch<ListAnswersResultView>(
      `/api/v1/admin/ai-tutor/answers${qs({ ...filters })}`,
      { method: 'GET' },
      bearer(),
    );
  },

  async review(messageId: string, input: ReviewAnswerInput): Promise<ReviewAnswerView> {
    return apiFetch<ReviewAnswerView>(
      `/api/v1/admin/ai-tutor/answers/${messageId}/review`,
      { method: 'POST', body: JSON.stringify(input) },
      bearer(),
    );
  },

  async listCorrections(courseId?: string): Promise<CorrectionView[]> {
    return apiFetch<CorrectionView[]>(
      `/api/v1/admin/ai-tutor/corrections${qs({ courseId })}`,
      { method: 'GET' },
      bearer(),
    );
  },

  async createCorrection(input: UpsertCorrectionInput): Promise<CorrectionView> {
    return apiFetch<CorrectionView>(
      '/api/v1/admin/ai-tutor/corrections',
      { method: 'POST', body: JSON.stringify(input) },
      bearer(),
    );
  },

  async updateCorrection(
    id: string,
    input: Partial<UpsertCorrectionInput>,
  ): Promise<CorrectionView> {
    return apiFetch<CorrectionView>(
      `/api/v1/admin/ai-tutor/corrections/${id}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      bearer(),
    );
  },

  async deleteCorrection(id: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/admin/ai-tutor/corrections/${id}`,
      { method: 'DELETE' },
      bearer(),
    );
  },

  async monthlyReport(mes?: string, courseId?: string): Promise<MonthlyReportView> {
    return apiFetch<MonthlyReportView>(
      `/api/v1/admin/ai-tutor/report/monthly${qs({ mes, courseId })}`,
      { method: 'GET' },
      bearer(),
    );
  },
};

export const aiProvidersApi = {
  async catalog(): Promise<ProviderCatalogEntry[]> {
    return apiFetch<ProviderCatalogEntry[]>(
      '/api/v1/admin/ai/providers/catalog',
      { method: 'GET' },
      bearer(),
    );
  },

  async list(): Promise<TenantProviderConfig[]> {
    return apiFetch<TenantProviderConfig[]>(
      '/api/v1/admin/ai/providers',
      { method: 'GET' },
      bearer(),
    );
  },

  async upsert(
    purpose: 'chat' | 'embed',
    input: UpsertProviderInput,
  ): Promise<TenantProviderConfig> {
    return apiFetch<TenantProviderConfig>(
      `/api/v1/admin/ai/providers/${purpose}`,
      { method: 'PUT', body: JSON.stringify(input) },
      bearer(),
    );
  },

  async remove(purpose: 'chat' | 'embed'): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/admin/ai/providers/${purpose}`,
      { method: 'DELETE' },
      bearer(),
    );
  },
};
