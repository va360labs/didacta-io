-- Migración inicial mod.migrator-learndash 1.0.0
-- Tablas con prefijo mod_migrator_learndash_* (regla R2)
-- Toda tabla lleva tenant_id (regla R3 — RLS strict aplicada por host)
-- Cero FKs cross-module (regla R4)

-- ============================================================
-- Job principal
-- ============================================================
CREATE TABLE "mod_migrator_learndash_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "status" TEXT NOT NULL,
  "phase" TEXT,
  "source_profile" JSONB NOT NULL,
  "options" JSONB NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "progress" JSONB,
  "error" JSONB,
  "created_by" TEXT NOT NULL,
  "retention_days" INTEGER NOT NULL DEFAULT 30,
  "purged_at" TIMESTAMP(3),

  CONSTRAINT "mod_migrator_learndash_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mod_migrator_learndash_jobs_tenant_status_idx"
  ON "mod_migrator_learndash_jobs" ("tenant_id", "status");
CREATE INDEX "mod_migrator_learndash_jobs_tenant_creator_started_idx"
  ON "mod_migrator_learndash_jobs" ("tenant_id", "created_by", "started_at");

-- ============================================================
-- Mapeo source_id -> target_id
-- ============================================================
CREATE TABLE "mod_migrator_learndash_mappings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "entity_type" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "target_id" TEXT,
  "external_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "checksum" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "mod_migrator_learndash_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_migrator_learndash_mappings_unique"
  ON "mod_migrator_learndash_mappings" ("tenant_id", "job_id", "entity_type", "source_id");
CREATE INDEX "mod_migrator_learndash_mappings_lookup_idx"
  ON "mod_migrator_learndash_mappings" ("tenant_id", "entity_type", "source_id");
CREATE INDEX "mod_migrator_learndash_mappings_job_status_idx"
  ON "mod_migrator_learndash_mappings" ("tenant_id", "job_id", "status");
CREATE INDEX "mod_migrator_learndash_mappings_external_idx"
  ON "mod_migrator_learndash_mappings" ("tenant_id", "external_id");

-- ============================================================
-- DLQ
-- ============================================================
CREATE TABLE "mod_migrator_learndash_dlq" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "entity_type" TEXT NOT NULL,
  "source_id" TEXT,
  "phase" TEXT NOT NULL,
  "error_code" TEXT NOT NULL,
  "error_message" TEXT NOT NULL,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mod_migrator_learndash_dlq_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mod_migrator_learndash_dlq_job_phase_idx"
  ON "mod_migrator_learndash_dlq" ("tenant_id", "job_id", "phase");
CREATE INDEX "mod_migrator_learndash_dlq_error_idx"
  ON "mod_migrator_learndash_dlq" ("tenant_id", "error_code");

-- ============================================================
-- Audit events (append-only, cadena SHA-256)
-- ============================================================
CREATE TABLE "mod_migrator_learndash_audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entity_type" TEXT,
  "entity_id" TEXT,
  "meta" JSONB,
  "prev_hash" TEXT,
  "hash" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mod_migrator_learndash_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mod_migrator_learndash_audit_events_job_time_idx"
  ON "mod_migrator_learndash_audit_events" ("tenant_id", "job_id", "occurred_at");
CREATE INDEX "mod_migrator_learndash_audit_events_action_idx"
  ON "mod_migrator_learndash_audit_events" ("tenant_id", "action");

-- ============================================================
-- Validation reports
-- ============================================================
CREATE TABLE "mod_migrator_learndash_validation_reports" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "entity_type" TEXT NOT NULL,
  "source_count" INTEGER NOT NULL,
  "staged_count" INTEGER NOT NULL,
  "valid_count" INTEGER NOT NULL,
  "loaded_count" INTEGER NOT NULL,
  "skipped_count" INTEGER NOT NULL,
  "failed_count" INTEGER NOT NULL,
  "skip_reasons" JSONB,
  "failure_reasons" JSONB,
  "sample_diffs" JSONB,
  "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mod_migrator_learndash_validation_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_migrator_learndash_validation_reports_unique"
  ON "mod_migrator_learndash_validation_reports" ("tenant_id", "job_id", "entity_type");

-- ============================================================
-- Staging tables — patrón común
-- (cada tabla tiene tenant_id + job_id + source_id + raw_payload + canonical + is_valid + checksum)
-- ============================================================

CREATE TABLE "mod_migrator_learndash_stg_users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_id" TEXT NOT NULL,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "is_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "validation_errors" JSONB,
  "loaded_at" TIMESTAMP(3),
  "target_id" TEXT,
  "checksum" TEXT NOT NULL,
  CONSTRAINT "mod_migrator_learndash_stg_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mod_migrator_learndash_stg_users_unique"
  ON "mod_migrator_learndash_stg_users" ("tenant_id", "job_id", "source_id");
CREATE INDEX "mod_migrator_learndash_stg_users_valid_idx"
  ON "mod_migrator_learndash_stg_users" ("tenant_id", "job_id", "is_valid");

CREATE TABLE "mod_migrator_learndash_stg_courses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_id" TEXT NOT NULL,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "is_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "validation_errors" JSONB,
  "loaded_at" TIMESTAMP(3),
  "target_id" TEXT,
  "checksum" TEXT NOT NULL,
  CONSTRAINT "mod_migrator_learndash_stg_courses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mod_migrator_learndash_stg_courses_unique"
  ON "mod_migrator_learndash_stg_courses" ("tenant_id", "job_id", "source_id");
CREATE INDEX "mod_migrator_learndash_stg_courses_valid_idx"
  ON "mod_migrator_learndash_stg_courses" ("tenant_id", "job_id", "is_valid");

CREATE TABLE "mod_migrator_learndash_stg_lessons" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_id" TEXT NOT NULL,
  "parent_course_id" TEXT,
  "order_idx" INTEGER NOT NULL DEFAULT 0,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "is_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "validation_errors" JSONB,
  "loaded_at" TIMESTAMP(3),
  "target_id" TEXT,
  "checksum" TEXT NOT NULL,
  CONSTRAINT "mod_migrator_learndash_stg_lessons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mod_migrator_learndash_stg_lessons_unique"
  ON "mod_migrator_learndash_stg_lessons" ("tenant_id", "job_id", "source_id");
CREATE INDEX "mod_migrator_learndash_stg_lessons_parent_idx"
  ON "mod_migrator_learndash_stg_lessons" ("tenant_id", "job_id", "parent_course_id", "order_idx");

CREATE TABLE "mod_migrator_learndash_stg_topics" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_id" TEXT NOT NULL,
  "parent_lesson_id" TEXT,
  "parent_course_id" TEXT,
  "order_idx" INTEGER NOT NULL DEFAULT 0,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "is_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "validation_errors" JSONB,
  "loaded_at" TIMESTAMP(3),
  "target_id" TEXT,
  "checksum" TEXT NOT NULL,
  CONSTRAINT "mod_migrator_learndash_stg_topics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mod_migrator_learndash_stg_topics_unique"
  ON "mod_migrator_learndash_stg_topics" ("tenant_id", "job_id", "source_id");
CREATE INDEX "mod_migrator_learndash_stg_topics_parent_idx"
  ON "mod_migrator_learndash_stg_topics" ("tenant_id", "job_id", "parent_lesson_id", "order_idx");

CREATE TABLE "mod_migrator_learndash_stg_quizzes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_id" TEXT NOT NULL,
  "parent_course_id" TEXT,
  "parent_lesson_id" TEXT,
  "parent_topic_id" TEXT,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "is_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "validation_errors" JSONB,
  "loaded_at" TIMESTAMP(3),
  "target_id" TEXT,
  "checksum" TEXT NOT NULL,
  CONSTRAINT "mod_migrator_learndash_stg_quizzes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mod_migrator_learndash_stg_quizzes_unique"
  ON "mod_migrator_learndash_stg_quizzes" ("tenant_id", "job_id", "source_id");
CREATE INDEX "mod_migrator_learndash_stg_quizzes_job_idx"
  ON "mod_migrator_learndash_stg_quizzes" ("tenant_id", "job_id");

CREATE TABLE "mod_migrator_learndash_stg_questions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_id" TEXT NOT NULL,
  "parent_quiz_id" TEXT,
  "question_type" TEXT NOT NULL,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "is_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "validation_errors" JSONB,
  "loaded_at" TIMESTAMP(3),
  "target_id" TEXT,
  "checksum" TEXT NOT NULL,
  CONSTRAINT "mod_migrator_learndash_stg_questions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mod_migrator_learndash_stg_questions_unique"
  ON "mod_migrator_learndash_stg_questions" ("tenant_id", "job_id", "source_id");
CREATE INDEX "mod_migrator_learndash_stg_questions_quiz_idx"
  ON "mod_migrator_learndash_stg_questions" ("tenant_id", "job_id", "parent_quiz_id");

CREATE TABLE "mod_migrator_learndash_stg_groups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_id" TEXT NOT NULL,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "is_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "validation_errors" JSONB,
  "loaded_at" TIMESTAMP(3),
  "target_id" TEXT,
  "checksum" TEXT NOT NULL,
  CONSTRAINT "mod_migrator_learndash_stg_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mod_migrator_learndash_stg_groups_unique"
  ON "mod_migrator_learndash_stg_groups" ("tenant_id", "job_id", "source_id");
CREATE INDEX "mod_migrator_learndash_stg_groups_valid_idx"
  ON "mod_migrator_learndash_stg_groups" ("tenant_id", "job_id", "is_valid");

CREATE TABLE "mod_migrator_learndash_stg_enrollments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_user_id" TEXT NOT NULL,
  "source_course_id" TEXT,
  "source_group_id" TEXT,
  "enrollment_kind" TEXT NOT NULL,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "is_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "validation_errors" JSONB,
  "loaded_at" TIMESTAMP(3),
  "target_id" TEXT,
  "checksum" TEXT NOT NULL,
  CONSTRAINT "mod_migrator_learndash_stg_enrollments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mod_migrator_learndash_stg_enrollments_unique"
  ON "mod_migrator_learndash_stg_enrollments" ("tenant_id", "job_id", "source_user_id", "source_course_id", "source_group_id", "enrollment_kind");
CREATE INDEX "mod_migrator_learndash_stg_enrollments_user_idx"
  ON "mod_migrator_learndash_stg_enrollments" ("tenant_id", "job_id", "source_user_id");

CREATE TABLE "mod_migrator_learndash_stg_progress" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_user_id" TEXT NOT NULL,
  "source_course_id" TEXT NOT NULL,
  "source_step_id" TEXT,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "is_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "validation_errors" JSONB,
  "loaded_at" TIMESTAMP(3),
  "target_id" TEXT,
  "checksum" TEXT NOT NULL,
  CONSTRAINT "mod_migrator_learndash_stg_progress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mod_migrator_learndash_stg_progress_unique"
  ON "mod_migrator_learndash_stg_progress" ("tenant_id", "job_id", "source_user_id", "source_course_id", "source_step_id");
CREATE INDEX "mod_migrator_learndash_stg_progress_user_idx"
  ON "mod_migrator_learndash_stg_progress" ("tenant_id", "job_id", "source_user_id");

CREATE TABLE "mod_migrator_learndash_stg_media" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_id" TEXT NOT NULL,
  "source_url" TEXT NOT NULL,
  "mime_type" TEXT,
  "size_bytes" INTEGER,
  "raw_payload" JSONB NOT NULL,
  "canonical" JSONB,
  "is_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "validation_errors" JSONB,
  "loaded_at" TIMESTAMP(3),
  "target_id" TEXT,
  "storage_key" TEXT,
  "checksum" TEXT NOT NULL,
  CONSTRAINT "mod_migrator_learndash_stg_media_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mod_migrator_learndash_stg_media_unique"
  ON "mod_migrator_learndash_stg_media" ("tenant_id", "job_id", "source_id");
CREATE INDEX "mod_migrator_learndash_stg_media_valid_idx"
  ON "mod_migrator_learndash_stg_media" ("tenant_id", "job_id", "is_valid");
