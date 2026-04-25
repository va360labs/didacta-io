-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'PENDING', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'IN_APP', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LessonType" AS ENUM ('VIDEO', 'HTML', 'PDF', 'TEXT', 'QUIZ');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EnrollmentSource" AS ENUM ('ADMIN', 'CODE', 'INVITATION_LINK', 'PURCHASE', 'IMPORT');

-- CreateEnum
CREATE TYPE "QuizStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'EXPIRED', 'ABANDONED');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "module" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "enabled_by_default" BOOLEAN NOT NULL DEFAULT false,
    "manifest" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_module" (
    "tenant_id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_module_pkey" PRIMARY KEY ("tenant_id","module_id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "password_hash" TEXT,
    "mfa_secret" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_recovery_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "locale" TEXT NOT NULL DEFAULT 'es-ES',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "module_name" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "user_agent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prev_hash" TEXT,
    "hash" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_vault_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "content_type" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_vault_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "payload_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "processing_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret_hash" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_delivery_at" TIMESTAMP(3),

    CONSTRAINT "webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'es-ES',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_courses_course" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "thumbnail_url" TEXT,
    "language" TEXT NOT NULL DEFAULT 'es-ES',
    "estimated_minutes" INTEGER,
    "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "category" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_courses_course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_courses_module" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_courses_module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_courses_lesson" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "type" "LessonType" NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "duration_minutes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_courses_lesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_enrollment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "EnrollmentSource" NOT NULL DEFAULT 'ADMIN',
    "completion_threshold" INTEGER NOT NULL DEFAULT 75,
    "progress_percent" INTEGER NOT NULL DEFAULT 0,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "mod_learning_enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_progress" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "watched_seconds" INTEGER NOT NULL DEFAULT 0,
    "resume_position_sec" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "first_accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_accessed_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "mod_learning_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_invitation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "mod_learning_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_certificates_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "primary_color" TEXT NOT NULL DEFAULT '#0f172a',
    "logo_url" TEXT,
    "signer_name" TEXT,
    "signer_title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_certificates_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_certificates_issued" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "template_id" UUID,
    "number" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "storage_key" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" TEXT,

    CONSTRAINT "mod_certificates_issued_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_assessments_quiz" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lesson_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "QuizStatus" NOT NULL DEFAULT 'DRAFT',
    "pass_threshold" INTEGER NOT NULL DEFAULT 60,
    "max_attempts" INTEGER,
    "time_limit_minutes" INTEGER,
    "shuffle_questions" BOOLEAN NOT NULL DEFAULT false,
    "show_feedback" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_assessments_quiz_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_assessments_question" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quiz_id" UUID NOT NULL,
    "type" "QuestionType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "feedback" TEXT,
    "position" INTEGER NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_assessments_question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_assessments_option" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_assessments_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_assessments_attempt" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quiz_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "enrollment_id" UUID,
    "lesson_id" UUID,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "score_earned" INTEGER,
    "score_max" INTEGER,
    "score_percent" INTEGER,
    "passed" BOOLEAN,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),

    CONSTRAINT "mod_assessments_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_assessments_answer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "selected_option_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "score_earned" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_assessments_answer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_slug_idx" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_status_idx" ON "tenant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "module_name_key" ON "module"("name");

-- CreateIndex
CREATE INDEX "tenant_module_tenant_id_enabled_idx" ON "tenant_module"("tenant_id", "enabled");

-- CreateIndex
CREATE INDEX "user_tenant_id_status_idx" ON "user"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_id_email_key" ON "user"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "role_name_key" ON "role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permission_name_key" ON "permission"("name");

-- CreateIndex
CREATE INDEX "permission_module_name_idx" ON "permission"("module_name");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_token_hash_key" ON "api_key"("token_hash");

-- CreateIndex
CREATE INDEX "api_key_tenant_id_idx" ON "api_key"("tenant_id");

-- CreateIndex
CREATE INDEX "api_key_user_id_idx" ON "api_key"("user_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_timestamp_idx" ON "audit_log"("tenant_id", "timestamp");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_idx" ON "audit_log"("actor_id");

-- CreateIndex
CREATE INDEX "audit_log_resource_type_resource_id_idx" ON "audit_log"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "evidence_vault_entry_tenant_id_resource_type_resource_id_idx" ON "evidence_vault_entry"("tenant_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "evidence_vault_entry_hash_idx" ON "evidence_vault_entry"("hash");

-- CreateIndex
CREATE INDEX "outbox_event_processed_at_idx" ON "outbox_event"("processed_at");

-- CreateIndex
CREATE INDEX "outbox_event_tenant_id_event_name_idx" ON "outbox_event"("tenant_id", "event_name");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_tenant_id_idempotency_key_key" ON "outbox_event"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "webhook_tenant_id_enabled_idx" ON "webhook"("tenant_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "notification_template_tenant_id_key_channel_locale_key" ON "notification_template"("tenant_id", "key", "channel", "locale");

-- CreateIndex
CREATE INDEX "mod_courses_course_tenant_id_status_idx" ON "mod_courses_course"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_courses_course_tenant_id_category_idx" ON "mod_courses_course"("tenant_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "mod_courses_course_tenant_id_slug_key" ON "mod_courses_course"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "mod_courses_module_tenant_id_course_id_idx" ON "mod_courses_module"("tenant_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_courses_module_course_id_position_key" ON "mod_courses_module"("course_id", "position");

-- CreateIndex
CREATE INDEX "mod_courses_lesson_tenant_id_module_id_idx" ON "mod_courses_lesson"("tenant_id", "module_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_courses_lesson_module_id_position_key" ON "mod_courses_lesson"("module_id", "position");

-- CreateIndex
CREATE INDEX "mod_learning_enrollment_tenant_id_course_id_status_idx" ON "mod_learning_enrollment"("tenant_id", "course_id", "status");

-- CreateIndex
CREATE INDEX "mod_learning_enrollment_user_id_status_idx" ON "mod_learning_enrollment"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_enrollment_tenant_id_user_id_course_id_key" ON "mod_learning_enrollment"("tenant_id", "user_id", "course_id");

-- CreateIndex
CREATE INDEX "mod_learning_progress_tenant_id_lesson_id_idx" ON "mod_learning_progress"("tenant_id", "lesson_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_progress_enrollment_id_lesson_id_key" ON "mod_learning_progress"("enrollment_id", "lesson_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_invitation_token_key" ON "mod_learning_invitation"("token");

-- CreateIndex
CREATE INDEX "mod_learning_invitation_tenant_id_course_id_idx" ON "mod_learning_invitation"("tenant_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_invitation_tenant_id_code_key" ON "mod_learning_invitation"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "mod_certificates_template_tenant_id_is_default_idx" ON "mod_certificates_template"("tenant_id", "is_default");

-- CreateIndex
CREATE UNIQUE INDEX "mod_certificates_template_tenant_id_name_key" ON "mod_certificates_template"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "mod_certificates_issued_user_id_idx" ON "mod_certificates_issued"("user_id");

-- CreateIndex
CREATE INDEX "mod_certificates_issued_course_id_idx" ON "mod_certificates_issued"("course_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_certificates_issued_tenant_id_number_key" ON "mod_certificates_issued"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "mod_certificates_issued_tenant_id_enrollment_id_key" ON "mod_certificates_issued"("tenant_id", "enrollment_id");

-- CreateIndex
CREATE INDEX "mod_assessments_quiz_tenant_id_status_idx" ON "mod_assessments_quiz"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_assessments_quiz_tenant_id_lesson_id_idx" ON "mod_assessments_quiz"("tenant_id", "lesson_id");

-- CreateIndex
CREATE INDEX "mod_assessments_question_tenant_id_quiz_id_idx" ON "mod_assessments_question"("tenant_id", "quiz_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_assessments_question_quiz_id_position_key" ON "mod_assessments_question"("quiz_id", "position");

-- CreateIndex
CREATE INDEX "mod_assessments_option_tenant_id_question_id_idx" ON "mod_assessments_option"("tenant_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_assessments_option_question_id_position_key" ON "mod_assessments_option"("question_id", "position");

-- CreateIndex
CREATE INDEX "mod_assessments_attempt_tenant_id_quiz_id_user_id_idx" ON "mod_assessments_attempt"("tenant_id", "quiz_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_assessments_attempt_user_id_status_idx" ON "mod_assessments_attempt"("user_id", "status");

-- CreateIndex
CREATE INDEX "mod_assessments_answer_tenant_id_attempt_id_idx" ON "mod_assessments_answer"("tenant_id", "attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_assessments_answer_attempt_id_question_id_key" ON "mod_assessments_answer"("attempt_id", "question_id");

-- AddForeignKey
ALTER TABLE "tenant_module" ADD CONSTRAINT "tenant_module_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_module" ADD CONSTRAINT "tenant_module_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_vault_entry" ADD CONSTRAINT "evidence_vault_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook" ADD CONSTRAINT "webhook_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_courses_module" ADD CONSTRAINT "mod_courses_module_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "mod_courses_course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_courses_lesson" ADD CONSTRAINT "mod_courses_lesson_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "mod_courses_module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_learning_progress" ADD CONSTRAINT "mod_learning_progress_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "mod_learning_enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_assessments_question" ADD CONSTRAINT "mod_assessments_question_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "mod_assessments_quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_assessments_option" ADD CONSTRAINT "mod_assessments_option_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "mod_assessments_question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_assessments_attempt" ADD CONSTRAINT "mod_assessments_attempt_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "mod_assessments_quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_assessments_answer" ADD CONSTRAINT "mod_assessments_answer_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "mod_assessments_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

