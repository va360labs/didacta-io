'use client';

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface ScormPackageMetadata {
  id: string;
  lessonId: string;
  version: '1.2' | '2004';
  entryPath: string;
  storagePrefix: string;
  size: number;
  uploadedAt: string;
}

export interface ScormPackageWithUrl extends ScormPackageMetadata {
  entrySignedUrl: string;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export interface ScormAttemptState {
  id: string;
  lessonId: string;
  packageId: string;
  cmiData: Record<string, string>;
  completionStatus: string | null;
  scoreScaled: number | null;
  startedAt: string;
  lastAccessedAt: string;
  completedAt: string | null;
}

export const scormApi = {
  async get(lessonId: string): Promise<ScormPackageWithUrl> {
    return apiFetch<ScormPackageWithUrl>(
      `/api/v1/modules/learning/lessons/${encodeURIComponent(lessonId)}/scorm`,
      { method: 'GET' },
      withAuth(),
    );
  },
  async upload(
    lessonId: string,
    payload: { data: string; filename: string },
  ): Promise<ScormPackageMetadata> {
    return apiFetch<ScormPackageMetadata>(
      `/api/v1/modules/learning/lessons/${encodeURIComponent(lessonId)}/scorm`,
      { method: 'POST', body: JSON.stringify(payload) },
      withAuth(),
    );
  },
  async startAttempt(lessonId: string): Promise<ScormAttemptState> {
    return apiFetch<ScormAttemptState>(
      `/api/v1/modules/learning/lessons/${encodeURIComponent(lessonId)}/scorm/attempt`,
      { method: 'POST', body: '{}' },
      withAuth(),
    );
  },
  async commit(lessonId: string, cmiData: Record<string, string>): Promise<ScormAttemptState> {
    return apiFetch<ScormAttemptState>(
      `/api/v1/modules/learning/lessons/${encodeURIComponent(lessonId)}/scorm/commit`,
      { method: 'POST', body: JSON.stringify({ cmiData }) },
      withAuth(),
    );
  },
};
