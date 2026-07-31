/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Cliente HTTP del módulo migrator-learndash.
/// Habla con el dispatcher dinámico del marketplace bajo
/// `/api/v1/modules/migrator-learndash/*`. El módulo está cargado en VM
/// aislada del host; estas llamadas atraviesan el `ModulesDispatcherController`.
///
/// alpha.60: este cliente vive DENTRO del módulo (modules/migrator-learndash/
/// src/ui/) como parte del surface bundle. Antes vivía en apps/web/src/modules/
/// migrator-learndash/client.ts — violaba ADR-015 (independencia de módulos).
///
/// Las dependencias `apiFetch` + `ApiHttpError` se importan del shim
/// `_runtime.ts` que lee de `window.__didacta__` del host. Esto evita
/// bundlear React y shadcn dentro del ZIP del módulo (singletons del host).

import { apiFetchAuth as apiFetch } from './_runtime';

export interface SourceCredentials {
  baseUrl: string;
  username: string;
  appPassword: string;
}

/**
 * Modo "muestra" del importador. Cuando este campo está presente, el job
 * importa un solo curso aleatorio (de los que tienen alumnos) + N alumnos
 * + la jerarquía del curso, en lugar del scope completo. La integración
 * completa posterior se ejecuta sin este campo y NO duplica las entidades
 * del sample (loader idempotente por sourceId).
 */
export interface SampleConfig {
  /** Nº de cursos a incluir. v1: siempre 1. */
  courses: number;
  /** Máximo de alumnos a importar del curso elegido. */
  usersPerCourse: number;
}

export interface ImportOptions {
  /**
   * Qué migrar (v1.1.0+). El backend (readScopeConfig) lo lee y deriva qué
   * entidades extrae/carga. 'all' = comportamiento legacy (todo).
   *   - 'courses': solo contenido (cursos + lecciones + temas + quizzes).
   *   - 'enrolled-students': solo usuarios con ≥1 matrícula + sus matrículas
   *     (asume cursos ya migrados; modo diferido).
   *   - 'all': todo.
   */
  mode: 'courses' | 'enrolled-students' | 'all';
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
  /** Si está set, el job corre en modo muestra (ver SampleConfig). */
  sample?: SampleConfig;
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
  /// alpha.56+: el cursor de la fase actual lo escribe ET-001..ET-005 con
  /// shape distinta al placeholder anterior `{current, total, lastUpdate}`.
  /// Ver `parseProgressCursor` en `jobs-monitor.tsx` para el parsing.
  progress: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  createdBy: string;
  options: ImportOptions;
}

export interface JobReport {
  jobId: string;
  status?: JobStatus['status'];
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
  auditChain: {
    eventsCount: number;
    firstHash?: string | null;
    lastHash?: string | null;
    verified: boolean;
  };
}

export interface DlqEntry {
  entityType: string;
  sourceId: string | null;
  phase: string;
  errorCode: string;
  errorMessage: string;
  createdAt: string;
}

export interface DlqPage {
  items: DlqEntry[];
  total: number;
  limit: number;
  phase: string | null;
  entity: string | null;
}

const BASE = '/api/v1/modules/migrator-learndash';

export const migratorLearndashApi = {
  async ping(): Promise<{ ok: boolean; name: string; version: string; ts: string }> {
    return apiFetch(`${BASE}/ping`, { method: 'GET' });
  },
  async preflight(credentials: SourceCredentials): Promise<PreflightResult> {
    return apiFetch(`${BASE}/preflight`, {
      method: 'POST',
      body: JSON.stringify({ credentials }),
    });
  },
  async startJob(
    credentials: SourceCredentials,
    options: ImportOptions,
  ): Promise<StartJobResponse> {
    return apiFetch(`${BASE}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ credentials, options }),
    });
  },
  async listJobs(): Promise<{ items: JobStatus[] }> {
    return apiFetch(`${BASE}/jobs`, { method: 'GET' });
  },
  async getJob(jobId: string): Promise<JobStatus> {
    return apiFetch(`${BASE}/jobs/${jobId}`, { method: 'GET' });
  },
  async cancelJob(jobId: string): Promise<{ ok: true }> {
    return apiFetch(`${BASE}/jobs/${jobId}/cancel`, { method: 'POST', body: JSON.stringify({}) });
  },
  async getReport(jobId: string): Promise<JobReport> {
    return apiFetch(`${BASE}/jobs/${jobId}/report`, { method: 'GET' });
  },
  async getDlq(
    jobId: string,
    opts: { limit?: number; phase?: string; entity?: string } = {},
  ): Promise<DlqPage> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.phase) params.set('phase', opts.phase);
    if (opts.entity) params.set('entity', opts.entity);
    const qs = params.toString();
    return apiFetch(`${BASE}/jobs/${jobId}/dlq${qs ? '?' + qs : ''}`, { method: 'GET' });
  },
};
