/**
 * Puertos abstractos del ETL. El módulo no depende de Prisma ni de Nest
 * directamente — recibe implementaciones por inyección. Esto permite:
 *  - testear sin BD (mock in-memory)
 *  - cambiar el runtime sin tocar la lógica
 *  - reusar el orquestador en otros migradores derivando los puertos
 */
import type {
  CanonicalCourse,
  CanonicalEnrollment,
  CanonicalGroup,
  CanonicalLearningUnit,
  CanonicalAssessment,
  CanonicalQuestion,
  CanonicalUser,
  CanonicalMedia,
  CanonicalProgress,
} from '../mappers/canonical.js';

// ---- Job & state -----------------------------------------------------

export interface JobRecord {
  id: string;
  tenantId: string;
  status: string;
  phase: string | null;
  sourceProfile: Record<string, unknown>;
  options: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date | null;
  progress: { current: number; total: number; lastUpdate: string } | null;
  error: { code: string; message: string } | null;
  createdBy: string;
  retentionDays: number;
}

export interface JobsPort {
  create(record: Omit<JobRecord, 'startedAt' | 'completedAt' | 'progress' | 'error'>): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | null>;
  updateStatus(jobId: string, status: string, phase?: string | null): Promise<void>;
  updateProgress(jobId: string, current: number, total: number): Promise<void>;
  setError(jobId: string, code: string, message: string): Promise<void>;
  complete(jobId: string): Promise<void>;
  isCancelling(jobId: string): Promise<boolean>;
  findActiveForTenant(tenantId: string): Promise<JobRecord | null>;
}

// ---- Staging ---------------------------------------------------------

export interface StagedRow<T = unknown> {
  id: string;
  tenantId: string;
  jobId: string;
  sourceId: string;
  rawPayload: T;
  canonical: unknown | null;
  isValid: boolean;
  validationErrors: unknown | null;
  loadedAt: Date | null;
  targetId: string | null;
  checksum: string;
}

export interface StagingPort {
  upsertUser(tenantId: string, jobId: string, sourceId: string, rawPayload: unknown, checksum: string): Promise<StagedRow>;
  upsertCourse(tenantId: string, jobId: string, sourceId: string, rawPayload: unknown, checksum: string): Promise<StagedRow>;
  upsertLesson(
    tenantId: string,
    jobId: string,
    sourceId: string,
    parentCourseId: string | null,
    orderIdx: number,
    rawPayload: unknown,
    checksum: string,
  ): Promise<StagedRow>;
  upsertTopic(
    tenantId: string,
    jobId: string,
    sourceId: string,
    parentLessonId: string | null,
    parentCourseId: string | null,
    orderIdx: number,
    rawPayload: unknown,
    checksum: string,
  ): Promise<StagedRow>;
  upsertQuiz(
    tenantId: string,
    jobId: string,
    sourceId: string,
    parents: { courseId?: string; lessonId?: string; topicId?: string },
    rawPayload: unknown,
    checksum: string,
  ): Promise<StagedRow>;
  upsertQuestion(
    tenantId: string,
    jobId: string,
    sourceId: string,
    parentQuizId: string | null,
    questionType: string,
    rawPayload: unknown,
    checksum: string,
  ): Promise<StagedRow>;
  upsertGroup(tenantId: string, jobId: string, sourceId: string, rawPayload: unknown, checksum: string): Promise<StagedRow>;
  upsertEnrollment(
    tenantId: string,
    jobId: string,
    parts: {
      sourceUserId: string;
      sourceCourseId: string | null;
      sourceGroupId: string | null;
      enrollmentKind: 'direct' | 'group';
    },
    rawPayload: unknown,
    checksum: string,
  ): Promise<StagedRow>;
  upsertProgress(
    tenantId: string,
    jobId: string,
    parts: { sourceUserId: string; sourceCourseId: string; sourceStepId: string | null },
    rawPayload: unknown,
    checksum: string,
  ): Promise<StagedRow>;
  upsertMedia(
    tenantId: string,
    jobId: string,
    sourceId: string,
    sourceUrl: string,
    rawPayload: unknown,
    checksum: string,
  ): Promise<StagedRow>;

  // Transform: setea canonical + isValid o validation_errors
  setCanonical(table: StagingTable, rowId: string, canonical: unknown, isValid: boolean, validationErrors?: unknown): Promise<void>;

  // Load: marca como loaded
  markLoaded(table: StagingTable, rowId: string, targetId: string): Promise<void>;

  // Listados para fases
  listValid(table: StagingTable, tenantId: string, jobId: string, limit: number, afterId?: string): Promise<StagedRow[]>;
  listAll(table: StagingTable, tenantId: string, jobId: string, limit: number, afterId?: string): Promise<StagedRow[]>;
  count(table: StagingTable, tenantId: string, jobId: string): Promise<number>;
  countValid(table: StagingTable, tenantId: string, jobId: string): Promise<number>;
  countLoaded(table: StagingTable, tenantId: string, jobId: string): Promise<number>;
}

export type StagingTable =
  | 'users'
  | 'courses'
  | 'lessons'
  | 'topics'
  | 'quizzes'
  | 'questions'
  | 'groups'
  | 'enrollments'
  | 'progress'
  | 'media';

// ---- Mappings --------------------------------------------------------

export interface MappingsPort {
  upsert(
    tenantId: string,
    jobId: string,
    entityType: string,
    sourceId: string,
    externalId: string,
    status: string,
    targetId?: string,
    checksum?: string,
  ): Promise<void>;
  resolveTargetId(tenantId: string, entityType: string, sourceId: string): Promise<string | null>;
  setStatus(tenantId: string, jobId: string, entityType: string, sourceId: string, status: string, targetId?: string): Promise<void>;
  countByStatus(tenantId: string, jobId: string, entityType: string, status: string): Promise<number>;
}

// ---- DLQ -------------------------------------------------------------

export interface DlqPort {
  add(
    tenantId: string,
    jobId: string,
    entityType: string,
    sourceId: string | null,
    phase: string,
    errorCode: string,
    errorMessage: string,
    rawPayload: unknown,
    canonical?: unknown,
  ): Promise<void>;
  countByJob(tenantId: string, jobId: string): Promise<number>;
  groupByErrorCode(tenantId: string, jobId: string, entityType?: string): Promise<{ code: string; count: number; samples: { sourceId: string; message: string }[] }[]>;
}

// ---- Audit (chain) ---------------------------------------------------

export interface AuditPort {
  append(
    tenantId: string,
    jobId: string,
    actor: string,
    action: string,
    entityType: string | null,
    entityId: string | null,
    meta: unknown,
  ): Promise<{ id: string; hash: string }>;
  verify(tenantId: string, jobId: string): Promise<{ valid: boolean; firstHash?: string; lastHash?: string; eventsCount: number; brokenAtId?: string }>;
}

// ---- Validation Reports ---------------------------------------------

export interface ReportsPort {
  upsert(
    tenantId: string,
    jobId: string,
    entityType: string,
    counts: {
      sourceCount: number;
      stagedCount: number;
      validCount: number;
      loadedCount: number;
      skippedCount: number;
      failedCount: number;
    },
    skipReasons?: { code: string; count: number }[],
    failureReasons?: { code: string; count: number; sample: { sourceId: string; message: string }[] }[],
  ): Promise<void>;
  list(tenantId: string, jobId: string): Promise<unknown[]>;
}

// ---- Loader (API pública de los módulos destino) --------------------

export interface LoaderPort {
  upsertUser(
    tenantId: string,
    user: CanonicalUser,
    options: { passwordStrategy: 'activation_reset' | 'preserve_hash' },
  ): Promise<{ id: string; created: boolean }>;
  upsertCourse(tenantId: string, course: CanonicalCourse): Promise<{ id: string; created: boolean }>;
  upsertLearningUnit(tenantId: string, unit: CanonicalLearningUnit): Promise<{ id: string; created: boolean }>;
  upsertAssessment(tenantId: string, assessment: CanonicalAssessment): Promise<{ id: string; created: boolean }>;
  upsertQuestion(tenantId: string, question: CanonicalQuestion): Promise<{ id: string; created: boolean }>;
  upsertGroup(tenantId: string, group: CanonicalGroup): Promise<{ id: string; created: boolean }>;
  upsertEnrollment(tenantId: string, enrollment: CanonicalEnrollment): Promise<{ id: string; created: boolean }>;
  upsertProgress(tenantId: string, progress: CanonicalProgress): Promise<{ id: string; created: boolean }>;
  upsertMedia(
    tenantId: string,
    media: CanonicalMedia,
    options: { copyBinary: boolean; binaryProvider?: () => Promise<{ stream: AsyncIterable<Uint8Array>; sizeBytes?: number }> },
  ): Promise<{ id: string; created: boolean; storageKey?: string }>;
  rollbackByExternalId(
    tenantId: string,
    entityType: string,
    externalId: string,
  ): Promise<{ deleted: boolean; reason?: string }>;
}

// ---- Logger genérico --------------------------------------------------

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}
