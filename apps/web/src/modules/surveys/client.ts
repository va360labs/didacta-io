/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/**
 * Cliente HTTP de mod.surveys (bloque 2 — feedback/NPS). Las respuestas son
 * anónimas: el backend usa el token solo para dedupe (HMAC), nunca guarda
 * quién respondió.
 */

const BASE = '/api/v1/modules/surveys';

export type SurveyQuestionType = 'NPS' | 'SCALE' | 'TEXT';

export interface SurveyQuestionView {
  id: string;
  position: number;
  type: SurveyQuestionType;
  label: string;
}

export interface SessionSurveyView {
  id: string;
  title: string;
  status: 'OPEN' | 'CLOSED';
  alreadyAnswered: boolean;
  questions: SurveyQuestionView[];
}

export interface SurveyAnswerInput {
  questionId: string;
  valueInt?: number;
  valueText?: string;
}

export interface SurveyListItem {
  id: string;
  kind: string;
  title: string;
  status: 'OPEN' | 'CLOSED';
  zoomSessionId: string | null;
  createdAt: string;
  responseCount: number;
}

export interface SurveyQuestionResults {
  id: string;
  position: number;
  type: SurveyQuestionType;
  label: string;
  answerCount: number;
  nps: { promoters: number; passives: number; detractors: number; score: number } | null;
  average: number | null;
  texts: string[];
}

export interface SurveyResults {
  id: string;
  title: string;
  kind: string;
  status: 'OPEN' | 'CLOSED';
  createdAt: string;
  responseCount: number;
  questions: SurveyQuestionResults[];
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

export const surveysApi = {
  /** Encuesta de una clase (o null si aún no existe). */
  async getForSession(sessionId: string): Promise<{ survey: SessionSurveyView | null }> {
    return apiFetch<{ survey: SessionSurveyView | null }>(
      `${BASE}/sessions/${sessionId}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async submit(surveyId: string, answers: SurveyAnswerInput[]): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(
      `${BASE}/${surveyId}/responses`,
      { method: 'POST', body: JSON.stringify({ answers }) },
      withAuth(),
    );
  },
};

export const surveysAdminApi = {
  async list(): Promise<{ surveys: SurveyListItem[] }> {
    return apiFetch<{ surveys: SurveyListItem[] }>(`${BASE}/admin`, { method: 'GET' }, withAuth());
  },

  async results(surveyId: string): Promise<SurveyResults> {
    return apiFetch<SurveyResults>(
      `${BASE}/admin/${surveyId}/results`,
      { method: 'GET' },
      withAuth(),
    );
  },

  /** Crea (idempotente) la encuesta post-clase de una sesión sin esperar al webhook. */
  async createForSession(sessionId: string): Promise<{ surveyId: string; created: boolean }> {
    return apiFetch<{ surveyId: string; created: boolean }>(
      `${BASE}/admin/sessions/${sessionId}`,
      { method: 'POST' },
      withAuth(),
    );
  },

  async close(surveyId: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(
      `${BASE}/admin/${surveyId}/close`,
      { method: 'POST' },
      withAuth(),
    );
  },
};
