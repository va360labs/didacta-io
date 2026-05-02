import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

export interface CitationView {
  lessonId: string;
  lessonTitle: string | null;
  chunkOrdinal: number;
  snippet: string;
}

export interface AskResponseView {
  answer: string;
  citations: CitationView[];
  conversationId: string;
  tokensUsed: { input: number; output: number };
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
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const aiTutorApi = {
  /** El alumno (o cualquier usuario autenticado) pregunta al tutor del curso. */
  async ask(
    courseId: string,
    input: { question: string; conversationId?: string; topK?: number },
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
