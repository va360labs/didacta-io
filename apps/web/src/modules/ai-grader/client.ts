/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

export interface RubricCriterion {
  name: string;
  description: string;
  weight: number;
}

export interface Rubric {
  id: string;
  questionId: string;
  instructions: string;
  criteria: RubricCriterion[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CriterionScore {
  name: string;
  score: number;
  justification: string;
}

export interface Suggestion {
  id: string;
  attemptId: string;
  answerId: string;
  questionId: string;
  proposedScore: number;
  perCriterion: CriterionScore[];
  overallFeedback: string;
  provider: string;
  model: string;
  applied: boolean;
  createdAt: string;
}

export interface SuggestForAttemptResult {
  attemptId: string;
  generated: Suggestion[];
  skipped: Array<{ questionId: string; reason: string }>;
  tokensUsed: { input: number; output: number };
  durationMs: number;
}

export interface UpsertRubricInput {
  instructions: string;
  criteria: RubricCriterion[];
  enabled?: boolean;
}

function bearer(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const aiGraderApi = {
  async getRubric(questionId: string): Promise<Rubric | null> {
    return apiFetch<Rubric | null>(
      `/api/v1/modules/ai-grader/questions/${questionId}/rubric`,
      { method: 'GET' },
      bearer(),
    );
  },

  async upsertRubric(questionId: string, input: UpsertRubricInput): Promise<Rubric> {
    return apiFetch<Rubric>(
      `/api/v1/modules/ai-grader/questions/${questionId}/rubric`,
      { method: 'PUT', body: JSON.stringify(input) },
      bearer(),
    );
  },

  async removeRubric(questionId: string): Promise<{ deleted: boolean }> {
    return apiFetch<{ deleted: boolean }>(
      `/api/v1/modules/ai-grader/questions/${questionId}/rubric`,
      { method: 'DELETE' },
      bearer(),
    );
  },

  /** Genera (o reusa cache) sugerencias para todas las open-ended del attempt. */
  async suggestForAttempt(attemptId: string, force = false): Promise<SuggestForAttemptResult> {
    return apiFetch<SuggestForAttemptResult>(
      `/api/v1/modules/ai-grader/attempts/${attemptId}/suggest`,
      { method: 'POST', body: JSON.stringify({ force }) },
      bearer(),
    );
  },

  /** Lista sugerencias persistidas (no llama al modelo). */
  async listSuggestions(attemptId: string): Promise<Suggestion[]> {
    return apiFetch<Suggestion[]>(
      `/api/v1/modules/ai-grader/attempts/${attemptId}/suggestions`,
      { method: 'GET' },
      bearer(),
    );
  },

  async markApplied(suggestionId: string): Promise<Suggestion> {
    return apiFetch<Suggestion>(
      `/api/v1/modules/ai-grader/suggestions/${suggestionId}/apply`,
      { method: 'POST', body: '{}' },
      bearer(),
    );
  },
};
