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

/// Sample item devuelto por el preflight: las 5 entidades más recientes
/// por entidad para que el usuario vea qué hay en su WP origen antes de
/// confirmar la migración. Shape uniforme entre courses/lessons/topics/
/// quizzes/groups/users; algunos campos son '' o 'unknown' según la entidad.
export interface PreflightSample {
  id: string;
  title: string;
  slug: string;
  status: string;
  modified: string;
}

export interface PreflightResult {
  ok: boolean;
  siteName?: string;
  wpVersion?: string;
  latencyMs: number;
  counts: {
    courses: number | 'unknown';
    lessons: number | 'unknown';
    topics: number | 'unknown';
    quizzes: number | 'unknown';
    groups: number | 'unknown';
    users: number | 'unknown';
  };
  /// Las 5 entidades más recientes por CPT (alpha.49+). Permite mostrar
  /// lista al usuario antes de confirmar para que decida qué migrar.
  samples?: {
    courses?: PreflightSample[];
    lessons?: PreflightSample[];
    topics?: PreflightSample[];
    quizzes?: PreflightSample[];
    groups?: PreflightSample[];
    users?: PreflightSample[];
  };
  warnings: { code: string; message: string }[];
  capabilities: { learndashV1: boolean; learndashV2: boolean; wpRest: boolean };
  error?: { code: string; message: string };
}

/// Notice que el backend devuelve junto al jobId cuando la creación del
/// job es exitosa pero el procesamiento real NO está disponible (alpha.49:
/// extract → transform → load → reconcile no implementado). El wizard
/// debería mostrar este notice como banner antes del estado "pending"
/// para que el usuario sepa que la importación NO va a ocurrir
/// automáticamente.
export interface JobNotice {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface StartJobResponse {
  jobId: string;
  notice?: JobNotice;
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
  async startJob(credentials: SourceCredentials, options: ImportOptions): Promise<StartJobResponse> {
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
