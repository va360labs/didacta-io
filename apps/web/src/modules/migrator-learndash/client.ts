/// Cliente HTTP del módulo migrator-learndash.
/// Habla con el dispatcher dinámico del marketplace bajo
/// `/api/v1/modules/migrator-learndash/*`. El módulo está cargado en VM
/// aislada del host; estas llamadas atraviesan el `ModulesDispatcherController`.

import { apiFetch, ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

export interface SourceCredentials {
  baseUrl: string;
  username: string;
  appPassword: string;
}

export interface ImportOptions {
  dedupeUsersBy: ('email' | 'username')[];
  passwordStrategy: 'activation_reset' | 'preserve_hash';
  copyMediaBinaries: boolean;
  preserveAttemptHistory: boolean;
  groupModelHint: 'cohort' | 'organization';
  scope: {
    courses: boolean;
    users: boolean;
    groups: boolean;
    enrollments: boolean;
    progress: boolean;
    media: boolean;
    quizzes: boolean;
  };
  dryRun: boolean;
  retentionDays: number;
}

export interface PreflightResult {
  ok: boolean;
  siteName?: string;
  latencyMs: number;
  counts: {
    courses: number;
    lessons: number;
    topics: number;
    quizzes: number;
    groups: number;
    users: number;
    media: number;
  };
  warnings: { code: string; message: string }[];
  capabilities: { learndashV1: boolean; learndashV2: boolean; wpRest: boolean };
  error?: { code: string; message: string };
}

export interface JobStatus {
  id: string;
  tenantId: string;
  status:
    | 'pending'
    | 'preflight'
    | 'extracting'
    | 'transforming'
    | 'loading'
    | 'reconciling'
    | 'completed'
    | 'failed'
    | 'cancelled';
  phase: string | null;
  startedAt: string;
  completedAt: string | null;
  progress: { current: number; total: number; lastUpdate: string } | null;
  error: { code: string; message: string } | null;
  createdBy: string;
  options: ImportOptions;
}

export interface JobReport {
  jobId: string;
  generatedAt: string;
  totals: { sourceCount: number; loadedCount: number; skippedCount: number; failedCount: number };
  byEntity: {
    entityType: string;
    sourceCount: number;
    stagedCount: number;
    validCount: number;
    loadedCount: number;
    skippedCount: number;
    failedCount: number;
  }[];
  auditChain: { eventsCount: number; firstHash?: string; lastHash?: string; verified: boolean };
}

const BASE = '/api/v1/modules/migrator-learndash';

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const migratorLearndashApi = {
  async ping(): Promise<{ ok: boolean; name: string; version: string; ts: string }> {
    return apiFetch(`${BASE}/ping`, { method: 'GET' }, withAuth());
  },
  async preflight(credentials: SourceCredentials): Promise<PreflightResult> {
    return apiFetch(
      `${BASE}/preflight`,
      { method: 'POST', body: JSON.stringify({ credentials }) },
      withAuth(),
    );
  },
  async startJob(credentials: SourceCredentials, options: ImportOptions): Promise<{ jobId: string }> {
    return apiFetch(
      `${BASE}/jobs`,
      { method: 'POST', body: JSON.stringify({ credentials, options }) },
      withAuth(),
    );
  },
  async listJobs(): Promise<{ items: JobStatus[] }> {
    return apiFetch(`${BASE}/jobs`, { method: 'GET' }, withAuth());
  },
  async getJob(jobId: string): Promise<JobStatus> {
    return apiFetch(`${BASE}/jobs/${jobId}`, { method: 'GET' }, withAuth());
  },
  async cancelJob(jobId: string): Promise<{ ok: true }> {
    return apiFetch(
      `${BASE}/jobs/${jobId}/cancel`,
      { method: 'POST', body: JSON.stringify({}) },
      withAuth(),
    );
  },
  async getReport(jobId: string): Promise<JobReport> {
    return apiFetch(`${BASE}/jobs/${jobId}/report`, { method: 'GET' }, withAuth());
  },
};
