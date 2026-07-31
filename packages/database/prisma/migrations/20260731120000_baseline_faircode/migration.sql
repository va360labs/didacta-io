-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'PENDING', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "NotificationPreferenceCategory" AS ENUM ('COMMUNITY', 'LEARNING', 'ASSESSMENTS', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'IN_APP', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "LessonCommentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LessonType" AS ENUM ('VIDEO', 'HTML', 'PDF', 'TEXT', 'QUIZ', 'SCORM');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED', 'PAUSED');

-- CreateEnum
CREATE TYPE "EnrollmentSource" AS ENUM ('ADMIN', 'CODE', 'INVITATION_LINK', 'PURCHASE', 'IMPORT', 'SUBSCRIPTION', 'API', 'GROUP');

-- CreateEnum
CREATE TYPE "DripAudienceKind" AS ENUM ('TIER', 'GROUP');

-- CreateEnum
CREATE TYPE "DripUnit" AS ENUM ('LESSON', 'MODULE');

-- CreateEnum
CREATE TYPE "QuizStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'FILL_IN_BLANK', 'SHORT_ANSWER', 'LONG_ANSWER');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'PENDING_REVIEW', 'GRADED', 'EXPIRED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "MemberDecisionAction" AS ENUM ('APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "BillingOrderStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'CANCELED');

-- CreateEnum
CREATE TYPE "SubscriptionInvoiceStatus" AS ENUM ('OPEN', 'PAID', 'UNCOLLECTIBLE', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentConnectionStatus" AS ENUM ('PENDING', 'VERIFIED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "AiContentDraftType" AS ENUM ('SUMMARY', 'FLASHCARDS', 'QUIZ');

-- CreateEnum
CREATE TYPE "AiContentDraftStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InstalledModuleVendor" AS ENUM ('DIDACTA', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "InstalledModuleSource" AS ENUM ('MARKETPLACE_OFFICIAL', 'MARKETPLACE_COMMUNITY', 'DIRECT_UPLOAD');

-- CreateEnum
CREATE TYPE "InstalledModuleStatus" AS ENUM ('INSTALLING', 'INSTALLED', 'FAILED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "AccessGroupKind" AS ENUM ('ALL_COURSES', 'COURSE', 'MULTI_COURSE');

-- CreateEnum
CREATE TYPE "LearningPathStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LearningPathSequenceType" AS ENUM ('LINEAR', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "LearningPathEnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReferralCommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REVOKED');

-- CreateEnum
CREATE TYPE "MessagingConversationType" AS ENUM ('SPACE', 'DM', 'FACULTY');

-- CreateEnum
CREATE TYPE "MessagingMessageKind" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'VIDEO_NOTE');

-- CreateEnum
CREATE TYPE "SurveyKind" AS ENUM ('POST_CLASS', 'POST_COURSE', 'GENERAL');

-- CreateEnum
CREATE TYPE "SurveyStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SurveyQuestionType" AS ENUM ('NPS', 'SCALE', 'TEXT');

-- CreateEnum
CREATE TYPE "ResourceKind" AS ENUM ('FILE', 'LINK');

-- CreateEnum
CREATE TYPE "GamificationChallengeStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "GamificationSubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "GamificationPerkRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DONE', 'REJECTED');

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
CREATE TABLE "tenant_domain" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "hostname" VARCHAR(253) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_setting" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "module_name" VARCHAR(100) NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "value_json" JSONB,
    "value_cipher" BYTEA,
    "value_iv" BYTEA,
    "value_tag" BYTEA,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_setting_pkey" PRIMARY KEY ("id")
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
    "bio" VARCHAR(280),
    "job_title" VARCHAR(120),
    "department" VARCHAR(120),
    "location" VARCHAR(120),
    "password_hash" TEXT,
    "mfa_secret" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_recovery_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'es-ES',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "avatar_url" TEXT,
    "document_id" VARCHAR(20),
    "external_source" VARCHAR(40),
    "external_id" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "onboarding_completed_at" TIMESTAMP(3),
    "telegram_id" VARCHAR(32),
    "telegram_in_group" BOOLEAN,
    "approval_decided_at" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_restriction" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scopes" TEXT[],
    "reason" VARCHAR(500) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMP(3),
    "lifted_by_id" UUID,
    "lift_reason" VARCHAR(500),

    CONSTRAINT "user_restriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_external_identity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "issuer" VARCHAR(255) NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "email_at_link" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "link_method" VARCHAR(30) NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_external_identity_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "user_notification_preference" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "NotificationPreferenceCategory" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_notification_preference_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "webhook_endpoint" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "event_types" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_dead_letter" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "last_error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_dead_letter_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "mod_community_post" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "course_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "author_display_name" TEXT,
    "source" TEXT NOT NULL DEFAULT 'web',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "hidden_at" TIMESTAMP(3),
    "hidden_by_id" UUID,
    "hidden_reason" TEXT,
    "pinned_at" TIMESTAMP(3),
    "pinned_by_id" UUID,

    CONSTRAINT "mod_community_post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_community_mention" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "post_id" UUID,
    "comment_id" UUID,
    "mentioned_user_id" UUID NOT NULL,
    "mentioned_handle" TEXT NOT NULL,
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_community_mention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_courses_category" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "icon" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_courses_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_lesson_comment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "author_display_name" TEXT,
    "body" TEXT NOT NULL,
    "status" "LessonCommentStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_learning_lesson_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_community_tag" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "icon" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_community_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_community_user_pref" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "digest_opt_out" BOOLEAN NOT NULL DEFAULT false,
    "broadcast_opt_out" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_community_user_pref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_community_broadcast" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "post_id" UUID,
    "important" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "cursor_user_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "mod_community_broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_community_space" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT NOT NULL DEFAULT '#',
    "color" TEXT NOT NULL DEFAULT 'var(--didacta-trust)',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_community_space_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_community_comment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "author_display_name" TEXT,
    "parent_comment_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "hidden_at" TIMESTAMP(3),
    "hidden_by_id" UUID,
    "hidden_reason" TEXT,

    CONSTRAINT "mod_community_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_community_reaction" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "post_id" UUID,
    "comment_id" UUID,
    "author_id" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_community_reaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "template_key" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_courses_course" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "thumbnail_url" TEXT,
    "featured_video_url" TEXT,
    "language" TEXT NOT NULL DEFAULT 'es-ES',
    "estimated_minutes" INTEGER,
    "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "category" TEXT,
    "external_purchase_url" VARCHAR(2048),
    "created_by_id" UUID,
    "certificate_template_id" UUID,
    "external_source" VARCHAR(40),
    "external_id" VARCHAR(200),
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
    "external_source" VARCHAR(40),
    "external_id" VARCHAR(200),
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
    "publish_at" TIMESTAMP(3),
    "external_source" VARCHAR(40),
    "external_id" VARCHAR(200),
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
    "external_source" VARCHAR(40),
    "external_id" VARCHAR(200),

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
CREATE TABLE "mod_learning_drip_schedule" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "audience_kind" "DripAudienceKind" NOT NULL,
    "audience_ref" TEXT NOT NULL,
    "unit" "DripUnit" NOT NULL DEFAULT 'LESSON',
    "interval_days" INTEGER NOT NULL,
    "start_offset_days" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_learning_drip_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_lesson_unlock_sub" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "mod_learning_lesson_unlock_sub_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "mod_learning_scorm_package" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "entry_path" TEXT NOT NULL,
    "storage_prefix" TEXT NOT NULL,
    "manifest" JSONB NOT NULL DEFAULT '{}',
    "size" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by_id" UUID,

    CONSTRAINT "mod_learning_scorm_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_scorm_attempt" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "cmi_data" JSONB NOT NULL DEFAULT '{}',
    "completion_status" TEXT,
    "score_scaled" DOUBLE PRECISION,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "mod_learning_scorm_attempt_pkey" PRIMARY KEY ("id")
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
    "external_source" VARCHAR(40),
    "external_id" VARCHAR(200),
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
    "accepted_answers" TEXT[] DEFAULT ARRAY[]::TEXT[],
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
    "graded_at" TIMESTAMP(3),
    "graded_by_id" UUID,

    CONSTRAINT "mod_assessments_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_assessments_answer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "selected_option_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "text_answer" TEXT,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "score_earned" INTEGER NOT NULL DEFAULT 0,
    "graded_feedback" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_assessments_answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_theming_tenant_theme" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "logo_url" TEXT,
    "logo_storage_key" TEXT,
    "logo_mime_type" TEXT,
    "favicon_url" TEXT,
    "brand_hue" INTEGER NOT NULL DEFAULT 213,
    "brand_saturation" INTEGER NOT NULL DEFAULT 70,
    "display_font_family" TEXT NOT NULL DEFAULT 'Sora',
    "body_font_family" TEXT NOT NULL DEFAULT 'Inter',
    "custom_css" TEXT,
    "footer_html" TEXT,
    "signin_headline" VARCHAR(160),
    "signin_subheadline" VARCHAR(240),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_theming_tenant_theme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_zoom_session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID,
    "lesson_id" UUID,
    "topic" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "start_time" TIMESTAMP(3) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "host_email" TEXT NOT NULL,
    "zoom_meeting_id" TEXT,
    "zoom_meeting_uuid" TEXT,
    "join_url" TEXT,
    "start_url" TEXT,
    "attendance_synced_at" TIMESTAMP(3),
    "attendance_sync_error" TEXT,
    "reminder_sent_at" TIMESTAMP(3),
    "recording_url" TEXT,
    "recording_duration_minutes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_zoom_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_zoom_session_registration" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_zoom_session_registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_zoom_session_attendance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID,
    "zoom_email" TEXT,
    "zoom_name" TEXT,
    "zoom_participant_id" TEXT,
    "clicked_join_at" TIMESTAMP(3),
    "present" BOOLEAN NOT NULL DEFAULT false,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMP(3),
    "left_at" TIMESTAMP(3),
    "manual_present" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_zoom_session_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_zoom_webhook_event" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "meeting_id" TEXT,
    "session_id" UUID,
    "tenant_id" UUID,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT NOT NULL DEFAULT 'OK',
    "error_message" TEXT,

    CONSTRAINT "mod_zoom_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_fundae_block" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "action_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "modalidad" TEXT NOT NULL,
    "contenidos" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_fundae_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_fundae_action" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID,
    "codigo_accion" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "modalidad" TEXT NOT NULL,
    "horas_formacion" DOUBLE PRECISION NOT NULL,
    "fecha_inicio" TEXT NOT NULL,
    "fecha_fin" TEXT NOT NULL,
    "lugar" TEXT,
    "cif_centro" TEXT,
    "notas" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_fundae_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_fundae_company" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "nif" VARCHAR(20) NOT NULL,
    "razon_social" VARCHAR(200) NOT NULL,
    "ccc_principal" VARCHAR(15),
    "plantilla" INTEGER,
    "credito_total_cents" INTEGER,
    "credito_usado_cents" INTEGER NOT NULL DEFAULT 0,
    "datos_contacto" JSONB NOT NULL DEFAULT '{}',
    "notas" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_fundae_company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_fundae_rlpt_notice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "fecha_notificacion_at" TIMESTAMP(3) NOT NULL,
    "plazo_vencimiento_at" TIMESTAMP(3) NOT NULL,
    "evidence_entry_id" UUID NOT NULL,
    "observaciones" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_fundae_rlpt_notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_fundae_group" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "action_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "numero_grupo" INTEGER NOT NULL,
    "modalidad" TEXT NOT NULL,
    "fecha_inicio_prevista" TIMESTAMP(3) NOT NULL,
    "fecha_fin_prevista" TIMESTAMP(3) NOT NULL,
    "fecha_inicio_real" TIMESTAMP(3),
    "fecha_fin_real" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "credito_estimado_cents" INTEGER,
    "umbral_finalizacion_pct" INTEGER NOT NULL DEFAULT 75,
    "notas" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_fundae_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_fundae_cost" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "concepto" VARCHAR(200) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "notas" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_fundae_cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_fundae_group_participant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "nif_alumno" TEXT,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ENROLLED',
    "horas_asistidas" DECIMAL(8,2),
    "progress_percent" INTEGER,
    "resultado" TEXT,
    "completed_at" TIMESTAMP(3),
    "notas" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_fundae_group_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "request_ip" TEXT,
    "request_ua" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_code" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "request_ip" TEXT,
    "request_ua" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_registration_decision_token" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" "MemberDecisionAction" NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "request_ip" TEXT,
    "request_ua" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_registration_decision_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_payment_flag" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "telegram_id" VARCHAR(32) NOT NULL,
    "name" TEXT,
    "is_delinquent" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_payment_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_subscription_lookup" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "results" JSONB NOT NULL DEFAULT '[]',
    "match_count" INTEGER NOT NULL DEFAULT 0,
    "purchases" JSONB NOT NULL DEFAULT '[]',
    "purchase_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "member_subscription_lookup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_ai_provider_config" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "api_key_cipher" TEXT NOT NULL,
    "api_key_iv" TEXT NOT NULL,
    "api_key_tag" TEXT NOT NULL,
    "base_url" TEXT,
    "extra_headers" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notas" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_ai_provider_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_ai_tutor_chunk" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "lesson_id" UUID,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "tokens_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_ai_tutor_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_ai_tutor_conversation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_ai_tutor_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_ai_tutor_message" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "tokens_input" INTEGER NOT NULL DEFAULT 0,
    "tokens_output" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "question_embedding" vector(1536),
    "review_status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,

    CONSTRAINT "mod_ai_tutor_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_ai_tutor_correction" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "source_message_id" UUID,
    "author_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "times_used" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_ai_tutor_correction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_ai_tutor_token_usage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "day" DATE NOT NULL,
    "tokens_input" INTEGER NOT NULL DEFAULT 0,
    "tokens_output" INTEGER NOT NULL DEFAULT 0,
    "questions" INTEGER NOT NULL DEFAULT 0,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_ai_tutor_token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_ai_grader_rubric" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "instructions" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_ai_grader_rubric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_ai_grader_suggestion" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "answer_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "proposed_score" INTEGER NOT NULL,
    "per_criterion" JSONB NOT NULL,
    "overall_feedback" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "applied_by_id" UUID,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_ai_grader_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core_installation_registry" (
    "id" UUID NOT NULL,
    "installation_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "organization_name" TEXT NOT NULL,
    "deployment_url" TEXT,
    "registry_token" TEXT,
    "terms_accepted_at" TIMESTAMP(3) NOT NULL,
    "opt_in_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opted_out_at" TIMESTAMP(3),
    "last_telemetry_at" TIMESTAMP(3),
    "telemetry_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_installation_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_billing_product" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "stripe_product_id" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "unit_amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "compare_at_amount" INTEGER,
    "name" TEXT NOT NULL DEFAULT '',
    "perks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "external_ref" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_billing_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_billing_order" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "stripe_session_id" TEXT NOT NULL,
    "stripe_payment_intent_id" TEXT,
    "status" "BillingOrderStatus" NOT NULL DEFAULT 'PENDING',
    "amount_paid" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "customer_email" TEXT,
    "completed_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_billing_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_billing_webhook_event" (
    "stripe_event_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "type" TEXT NOT NULL,
    "order_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "mod_billing_webhook_event_pkey" PRIMARY KEY ("stripe_event_id")
);

-- CreateTable
CREATE TABLE "mod_subscriptions_subscription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID,
    "plan_id" UUID,
    "stripe_subscription_id" TEXT,
    "stripe_customer_id" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "unit_amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "interval" TEXT NOT NULL,
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "grace_period_ends_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "canceled_reason" TEXT,
    "trial_ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_subscriptions_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_subscriptions_plan" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "interval_months" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "compare_at_cents" INTEGER,
    "trial_days" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "stripe_product_id" TEXT,
    "stripe_price_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_subscriptions_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_subscriptions_membership_config" (
    "tenant_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "headline" TEXT NOT NULL DEFAULT 'Hazte miembro',
    "subheadline" TEXT,
    "access_group_id" UUID,
    "show_courses" BOOLEAN NOT NULL DEFAULT true,
    "trial_lesson_limit" INTEGER NOT NULL DEFAULT 5,
    "course_prices" JSONB NOT NULL DEFAULT '[]',
    "testimonial_quote" TEXT,
    "testimonial_author" TEXT,
    "testimonial_role" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_subscriptions_membership_config_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "mod_subscriptions_invoice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "stripe_invoice_id" TEXT NOT NULL,
    "status" "SubscriptionInvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "hosted_invoice_url" TEXT,
    "paid_at" TIMESTAMP(3),
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_subscriptions_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_subscriptions_webhook_event" (
    "stripe_event_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "type" TEXT NOT NULL,
    "subscription_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "mod_subscriptions_webhook_event_pkey" PRIMARY KEY ("stripe_event_id")
);

-- CreateTable
CREATE TABLE "mod_payment_connections_connection" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "PaymentConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "public_metadata" JSONB,
    "last_verified_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payment_connections_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payment_connections_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "result_status" TEXT NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_payment_connections_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payment_connections_tier" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_free" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payment_connections_tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payment_connections_user_tier" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "manual_tier_id" UUID,
    "derived_label" TEXT,
    "derived_provider" TEXT,
    "derived_connection_id" UUID,
    "derived_ref" TEXT,
    "derived_synced_at" TIMESTAMP(3),
    "assigned_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payment_connections_user_tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payment_connections_subscriber" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "subscription_customer_id" TEXT,
    "user_id" UUID,
    "user_email" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "status_category" TEXT NOT NULL,
    "entitled" BOOLEAN NOT NULL DEFAULT false,
    "product_name" TEXT,
    "unit_amount" INTEGER,
    "currency" TEXT,
    "interval" TEXT,
    "current_period_end" TIMESTAMP(3),
    "renewal_url" TEXT,
    "renewal_warned_period_end" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payment_connections_subscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payment_connections_order" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "user_id" UUID,
    "customer_email" TEXT NOT NULL,
    "customer_name" TEXT,
    "status" TEXT NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "total_amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "placed_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "entitlement_kind" TEXT NOT NULL,
    "access_ends_at" TIMESTAMP(3),
    "expiry_warned_for" TIMESTAMP(3),
    "items" JSONB NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payment_connections_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payment_connections_sync_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "matched_count" INTEGER NOT NULL DEFAULT 0,
    "unmatched_count" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "mod_payment_connections_sync_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_ai_content_draft" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "type" "AiContentDraftType" NOT NULL,
    "status" "AiContentDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL DEFAULT '{}',
    "provider" TEXT,
    "model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_ai_content_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installed_module" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "prev_version" TEXT,
    "vendor" "InstalledModuleVendor" NOT NULL,
    "source" "InstalledModuleSource" NOT NULL DEFAULT 'DIRECT_UPLOAD',
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "manifest_json" JSONB NOT NULL,
    "manifest_jwt" TEXT,
    "signed_at" TIMESTAMP(3),
    "package_storage_key" TEXT NOT NULL,
    "package_sha256" TEXT NOT NULL,
    "package_size_bytes" INTEGER NOT NULL,
    "core_version_required" TEXT NOT NULL,
    "table_prefix" TEXT NOT NULL,
    "api_namespace" TEXT NOT NULL,
    "required_capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required_env_vars" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isolation" TEXT NOT NULL DEFAULT 'vm',
    "status" "InstalledModuleStatus" NOT NULL DEFAULT 'INSTALLING',
    "error_message" TEXT,
    "migrations_applied" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "migrations_applied_at" TIMESTAMP(3),
    "installed_by_id" UUID NOT NULL,
    "installed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installed_module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_secret" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "module_id" VARCHAR(60) NOT NULL,
    "secret_key" VARCHAR(128) NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "approx_value_bytes" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_group" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_group_member" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(30) NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_group_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_event_registration" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_event_registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_access_groups_group" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "AccessGroupKind" NOT NULL,
    "is_default_for_approval" BOOLEAN NOT NULL DEFAULT false,
    "auto_grant_new_courses" BOOLEAN NOT NULL DEFAULT true,
    "linked_tier_name" TEXT,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_access_groups_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_access_groups_group_course" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_access_groups_group_course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_access_groups_group_member" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "source" VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "mod_access_groups_group_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_access_groups_grant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "enrollment_external_id" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "mod_access_groups_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_path" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "sequence_type" "LearningPathSequenceType" NOT NULL DEFAULT 'LINEAR',
    "status" "LearningPathStatus" NOT NULL DEFAULT 'DRAFT',
    "estimated_minutes" INTEGER,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_learning_path_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_path_course" (
    "id" UUID NOT NULL,
    "path_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "mod_learning_path_course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_path_enrollment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "path_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "LearningPathEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "progress_percent" INTEGER NOT NULL DEFAULT 0,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "mod_learning_path_enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_competency" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(280),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_learning_competency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_learning_course_competency" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "competency_id" UUID NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_learning_course_competency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_referrals_config" (
    "tenant_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "commission_bps" INTEGER NOT NULL DEFAULT 3000,
    "scope" TEXT NOT NULL DEFAULT 'RECURRING',
    "recurring_months" INTEGER,
    "attribution_window_days" INTEGER NOT NULL DEFAULT 30,
    "guarantee_days" INTEGER NOT NULL DEFAULT 14,
    "min_payout_cents" INTEGER NOT NULL DEFAULT 5000,
    "require_active_membership" BOOLEAN NOT NULL DEFAULT true,
    "member_copy" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_referrals_config_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "mod_referrals_code" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_referrals_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_referrals_click" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code_id" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_referrals_click_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_referrals_referral" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "referrer_user_id" UUID NOT NULL,
    "referred_user_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "subscription_id" UUID NOT NULL,
    "plan_id" UUID,
    "attributed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_referrals_referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_referrals_commission" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "referral_id" UUID NOT NULL,
    "referrer_user_id" UUID NOT NULL,
    "stripe_invoice_id" TEXT NOT NULL,
    "base_amount_cents" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "commission_bps" INTEGER NOT NULL,
    "status" "ReferralCommissionStatus" NOT NULL DEFAULT 'PENDING',
    "approve_after" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" TEXT,
    "payout_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_referrals_commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_referrals_payout" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "referrer_user_id" UUID NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "external_reference" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_referrals_payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_messaging_conversation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" "MessagingConversationType" NOT NULL,
    "space_id" UUID,
    "student_id" UUID,
    "dm_key" TEXT,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_messaging_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_messaging_participant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_messaging_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_messaging_message" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "author_display_name" TEXT,
    "kind" "MessagingMessageKind" NOT NULL DEFAULT 'TEXT',
    "body" TEXT NOT NULL,
    "media_key" TEXT,
    "duration_ms" INTEGER,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_messaging_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_surveys_survey" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "SurveyKind" NOT NULL,
    "zoom_session_id" UUID,
    "course_id" UUID,
    "title" TEXT NOT NULL,
    "status" "SurveyStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "reminder_sent_at" TIMESTAMP(3),

    CONSTRAINT "mod_surveys_survey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_surveys_question" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "SurveyQuestionType" NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "mod_surveys_question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_surveys_response" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "respondent_hash" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_surveys_response_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_surveys_answer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "value_int" INTEGER,
    "value_text" TEXT,

    CONSTRAINT "mod_surveys_answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_resources_collection" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "cover_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_resources_collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_resources_resource" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "kind" "ResourceKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT NOT NULL,
    "file_name" TEXT,
    "zoom_session_id" UUID,
    "created_by_id" UUID NOT NULL,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_resources_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_ledger_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rule_key" VARCHAR(64) NOT NULL,
    "points" INTEGER NOT NULL,
    "source_key" VARCHAR(160) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "meta" JSONB,
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_gamification_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_profile" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "lifetime_points" INTEGER NOT NULL DEFAULT 0,
    "level_key" VARCHAR(64),
    "level_reached_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_rule" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "points" INTEGER NOT NULL,
    "daily_cap" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_level" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "min_points" INTEGER NOT NULL,
    "benefit_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_level_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_perk" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "level_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "max_per_user" INTEGER NOT NULL DEFAULT 1,
    "cooldown_days" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_perk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_perk_request" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "perk_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "note" TEXT,
    "status" "GamificationPerkRequestStatus" NOT NULL DEFAULT 'PENDING',
    "handled_by_id" UUID,
    "handled_at" TIMESTAMP(3),
    "staff_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_perk_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_challenge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "points" INTEGER NOT NULL,
    "proof_required" BOOLEAN NOT NULL DEFAULT true,
    "status" "GamificationChallengeStatus" NOT NULL DEFAULT 'DRAFT',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_submission" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "proof_url" TEXT,
    "proof_name" TEXT,
    "note" TEXT,
    "status" "GamificationSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_slug_idx" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_status_idx" ON "tenant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domain_hostname_key" ON "tenant_domain"("hostname");

-- CreateIndex
CREATE INDEX "tenant_domain_tenant_id_idx" ON "tenant_domain"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_setting_tenant_id_module_name_idx" ON "tenant_setting"("tenant_id", "module_name");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_setting_tenant_id_module_name_key_key" ON "tenant_setting"("tenant_id", "module_name", "key");

-- CreateIndex
CREATE UNIQUE INDEX "module_name_key" ON "module"("name");

-- CreateIndex
CREATE INDEX "tenant_module_tenant_id_enabled_idx" ON "tenant_module"("tenant_id", "enabled");

-- CreateIndex
CREATE INDEX "user_tenant_id_status_idx" ON "user"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "user_external_ref_idx" ON "user"("tenant_id", "external_source", "external_id");

-- CreateIndex
CREATE INDEX "user_tenant_telegram_idx" ON "user"("tenant_id", "telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_id_email_key" ON "user"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_document_id_key" ON "user"("tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "user_restriction_tenant_user_active_idx" ON "user_restriction"("tenant_id", "user_id", "lifted_at");

-- CreateIndex
CREATE INDEX "user_restriction_tenant_created_idx" ON "user_restriction"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "user_external_identity_tenant_id_provider_external_id_idx" ON "user_external_identity"("tenant_id", "provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_ext_identity_subject_key" ON "user_external_identity"("tenant_id", "provider", "issuer", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_ext_identity_one_per_provider_key" ON "user_external_identity"("tenant_id", "user_id", "provider", "issuer");

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
CREATE INDEX "user_notification_preference_tenant_id_user_id_idx" ON "user_notification_preference"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_notification_preference_unique" ON "user_notification_preference"("tenant_id", "user_id", "category", "channel");

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
CREATE INDEX "webhook_endpoint_tenant_id_active_idx" ON "webhook_endpoint"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoint_tenant_id_url_key" ON "webhook_endpoint"("tenant_id", "url");

-- CreateIndex
CREATE INDEX "webhook_dead_letter_tenant_id_created_at_idx" ON "webhook_dead_letter"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_dead_letter_endpoint_id_idx" ON "webhook_dead_letter"("endpoint_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_template_tenant_id_key_channel_locale_key" ON "notification_template"("tenant_id", "key", "channel", "locale");

-- CreateIndex
CREATE INDEX "mod_community_post_tenant_id_course_id_created_at_idx" ON "mod_community_post"("tenant_id", "course_id", "created_at");

-- CreateIndex
CREATE INDEX "mod_community_post_tenant_id_author_id_idx" ON "mod_community_post"("tenant_id", "author_id");

-- CreateIndex
CREATE INDEX "mod_community_post_tenant_id_pinned_at_idx" ON "mod_community_post"("tenant_id", "pinned_at");

-- CreateIndex
CREATE INDEX "mod_community_post_tags_idx" ON "mod_community_post" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "mod_community_mention_tenant_id_mentioned_user_id_created_a_idx" ON "mod_community_mention"("tenant_id", "mentioned_user_id", "created_at");

-- CreateIndex
CREATE INDEX "mod_community_mention_post_id_idx" ON "mod_community_mention"("post_id");

-- CreateIndex
CREATE INDEX "mod_community_mention_comment_id_idx" ON "mod_community_mention"("comment_id");

-- CreateIndex
CREATE INDEX "mod_courses_category_tenant_id_idx" ON "mod_courses_category"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_courses_category_tenant_name_key" ON "mod_courses_category"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "mod_learning_lesson_comment_tenant_id_lesson_id_status_idx" ON "mod_learning_lesson_comment"("tenant_id", "lesson_id", "status");

-- CreateIndex
CREATE INDEX "mod_learning_lesson_comment_tenant_id_course_id_status_idx" ON "mod_learning_lesson_comment"("tenant_id", "course_id", "status");

-- CreateIndex
CREATE INDEX "mod_learning_lesson_comment_tenant_id_author_id_status_idx" ON "mod_learning_lesson_comment"("tenant_id", "author_id", "status");

-- CreateIndex
CREATE INDEX "mod_community_tag_tenant_id_idx" ON "mod_community_tag"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_community_tag_tenant_name_key" ON "mod_community_tag"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "mod_community_user_pref_tenant_user_key" ON "mod_community_user_pref"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_community_broadcast_tenant_id_created_at_idx" ON "mod_community_broadcast"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "mod_community_space_tenant_id_sort_order_idx" ON "mod_community_space"("tenant_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "mod_community_space_tenant_id_slug_key" ON "mod_community_space"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "mod_community_comment_tenant_id_post_id_created_at_idx" ON "mod_community_comment"("tenant_id", "post_id", "created_at");

-- CreateIndex
CREATE INDEX "mod_community_comment_parent_comment_id_idx" ON "mod_community_comment"("parent_comment_id");

-- CreateIndex
CREATE INDEX "mod_community_reaction_tenant_id_post_id_idx" ON "mod_community_reaction"("tenant_id", "post_id");

-- CreateIndex
CREATE INDEX "mod_community_reaction_tenant_id_comment_id_idx" ON "mod_community_reaction"("tenant_id", "comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_community_reaction_author_id_post_id_emoji_key" ON "mod_community_reaction"("author_id", "post_id", "emoji");

-- CreateIndex
CREATE UNIQUE INDEX "mod_community_reaction_author_id_comment_id_emoji_key" ON "mod_community_reaction"("author_id", "comment_id", "emoji");

-- CreateIndex
CREATE INDEX "notification_tenant_id_user_id_read_at_idx" ON "notification"("tenant_id", "user_id", "read_at");

-- CreateIndex
CREATE INDEX "notification_tenant_id_channel_sent_at_idx" ON "notification"("tenant_id", "channel", "sent_at");

-- CreateIndex
CREATE INDEX "mod_courses_course_tenant_id_status_idx" ON "mod_courses_course"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_courses_course_tenant_id_category_idx" ON "mod_courses_course"("tenant_id", "category");

-- CreateIndex
CREATE INDEX "mod_courses_course_certificate_template_id_idx" ON "mod_courses_course"("certificate_template_id");

-- CreateIndex
CREATE INDEX "mod_courses_course_external_ref_idx" ON "mod_courses_course"("tenant_id", "external_source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_courses_course_tenant_id_slug_key" ON "mod_courses_course"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "mod_courses_module_tenant_id_course_id_idx" ON "mod_courses_module"("tenant_id", "course_id");

-- CreateIndex
CREATE INDEX "mod_courses_module_external_ref_idx" ON "mod_courses_module"("tenant_id", "external_source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_courses_module_course_id_position_key" ON "mod_courses_module"("course_id", "position");

-- CreateIndex
CREATE INDEX "mod_courses_lesson_tenant_id_module_id_idx" ON "mod_courses_lesson"("tenant_id", "module_id");

-- CreateIndex
CREATE INDEX "mod_courses_lesson_external_ref_idx" ON "mod_courses_lesson"("tenant_id", "external_source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_courses_lesson_module_id_position_key" ON "mod_courses_lesson"("module_id", "position");

-- CreateIndex
CREATE INDEX "mod_learning_enrollment_tenant_id_course_id_status_idx" ON "mod_learning_enrollment"("tenant_id", "course_id", "status");

-- CreateIndex
CREATE INDEX "mod_learning_enrollment_user_id_status_idx" ON "mod_learning_enrollment"("user_id", "status");

-- CreateIndex
CREATE INDEX "mod_learning_enrollment_external_ref_idx" ON "mod_learning_enrollment"("tenant_id", "external_source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_enrollment_tenant_id_user_id_course_id_key" ON "mod_learning_enrollment"("tenant_id", "user_id", "course_id");

-- CreateIndex
CREATE INDEX "mod_learning_progress_tenant_id_lesson_id_idx" ON "mod_learning_progress"("tenant_id", "lesson_id");

-- CreateIndex
CREATE INDEX "mod_learning_progress_tenant_id_enrollment_id_idx" ON "mod_learning_progress"("tenant_id", "enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_progress_enrollment_id_lesson_id_key" ON "mod_learning_progress"("enrollment_id", "lesson_id");

-- CreateIndex
CREATE INDEX "mod_learning_drip_schedule_tenant_id_course_id_idx" ON "mod_learning_drip_schedule"("tenant_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_drip_schedule_unique" ON "mod_learning_drip_schedule"("tenant_id", "course_id", "audience_kind", "audience_ref");

-- CreateIndex
CREATE INDEX "mod_learning_lesson_unlock_sub_tenant_id_lesson_id_idx" ON "mod_learning_lesson_unlock_sub"("tenant_id", "lesson_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_lesson_unlock_sub_unique" ON "mod_learning_lesson_unlock_sub"("lesson_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_invitation_token_key" ON "mod_learning_invitation"("token");

-- CreateIndex
CREATE INDEX "mod_learning_invitation_tenant_id_course_id_idx" ON "mod_learning_invitation"("tenant_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_invitation_tenant_id_code_key" ON "mod_learning_invitation"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_scorm_package_lesson_id_key" ON "mod_learning_scorm_package"("lesson_id");

-- CreateIndex
CREATE INDEX "mod_learning_scorm_package_tenant_id_idx" ON "mod_learning_scorm_package"("tenant_id");

-- CreateIndex
CREATE INDEX "mod_learning_scorm_attempt_tenant_id_user_id_idx" ON "mod_learning_scorm_attempt"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_learning_scorm_attempt_tenant_id_lesson_id_idx" ON "mod_learning_scorm_attempt"("tenant_id", "lesson_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_scorm_attempt_user_id_lesson_id_key" ON "mod_learning_scorm_attempt"("user_id", "lesson_id");

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
CREATE INDEX "mod_assessments_quiz_external_ref_idx" ON "mod_assessments_quiz"("tenant_id", "external_source", "external_id");

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

-- CreateIndex
CREATE UNIQUE INDEX "mod_theming_tenant_theme_tenant_id_key" ON "mod_theming_tenant_theme"("tenant_id");

-- CreateIndex
CREATE INDEX "mod_zoom_session_tenant_idx" ON "mod_zoom_session"("tenant_id", "start_time" DESC);

-- CreateIndex
CREATE INDEX "mod_zoom_session_course_idx" ON "mod_zoom_session"("course_id");

-- CreateIndex
CREATE INDEX "mod_zoom_session_lesson_idx" ON "mod_zoom_session"("lesson_id");

-- CreateIndex
CREATE INDEX "mod_zoom_session_registration_tenant_user_idx" ON "mod_zoom_session_registration"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_zoom_session_registration_unique" ON "mod_zoom_session_registration"("session_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_zoom_session_attendance_tenant_session_idx" ON "mod_zoom_session_attendance"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "mod_zoom_session_attendance_tenant_user_idx" ON "mod_zoom_session_attendance"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_zoom_session_attendance_unique" ON "mod_zoom_session_attendance"("session_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_zoom_webhook_event_event_id_key" ON "mod_zoom_webhook_event"("event_id");

-- CreateIndex
CREATE INDEX "mod_zoom_webhook_event_meeting_idx" ON "mod_zoom_webhook_event"("meeting_id");

-- CreateIndex
CREATE INDEX "mod_zoom_webhook_event_session_idx" ON "mod_zoom_webhook_event"("session_id");

-- CreateIndex
CREATE INDEX "mod_fundae_block_tenant_action_idx" ON "mod_fundae_block"("tenant_id", "action_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_fundae_block_action_ordinal_key" ON "mod_fundae_block"("action_id", "ordinal");

-- CreateIndex
CREATE INDEX "mod_fundae_action_tenant_inicio_idx" ON "mod_fundae_action"("tenant_id", "fecha_inicio" DESC);

-- CreateIndex
CREATE INDEX "mod_fundae_action_course_idx" ON "mod_fundae_action"("course_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_fundae_action_codigo_per_tenant_idx" ON "mod_fundae_action"("tenant_id", "codigo_accion");

-- CreateIndex
CREATE INDEX "mod_fundae_company_tenant_deleted_idx" ON "mod_fundae_company"("tenant_id", "deleted_at");

-- CreateIndex
CREATE INDEX "mod_fundae_company_tenant_razon_idx" ON "mod_fundae_company"("tenant_id", "razon_social");

-- CreateIndex
CREATE UNIQUE INDEX "mod_fundae_company_tenant_nif_key" ON "mod_fundae_company"("tenant_id", "nif");

-- CreateIndex
CREATE INDEX "mod_fundae_rlpt_tenant_company_tipo_idx" ON "mod_fundae_rlpt_notice"("tenant_id", "company_id", "tipo");

-- CreateIndex
CREATE INDEX "mod_fundae_rlpt_tenant_company_fecha_idx" ON "mod_fundae_rlpt_notice"("tenant_id", "company_id", "fecha_notificacion_at" DESC);

-- CreateIndex
CREATE INDEX "mod_fundae_rlpt_evidence_idx" ON "mod_fundae_rlpt_notice"("evidence_entry_id");

-- CreateIndex
CREATE INDEX "mod_fundae_group_tenant_company_status_idx" ON "mod_fundae_group"("tenant_id", "company_id", "status");

-- CreateIndex
CREATE INDEX "mod_fundae_group_tenant_action_status_idx" ON "mod_fundae_group"("tenant_id", "action_id", "status");

-- CreateIndex
CREATE INDEX "mod_fundae_group_tenant_status_fecha_idx" ON "mod_fundae_group"("tenant_id", "status", "fecha_inicio_prevista" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mod_fundae_group_action_numero_key" ON "mod_fundae_group"("tenant_id", "action_id", "numero_grupo");

-- CreateIndex
CREATE INDEX "mod_fundae_cost_tenant_group_tipo_idx" ON "mod_fundae_cost"("tenant_id", "group_id", "tipo");

-- CreateIndex
CREATE INDEX "mod_fundae_cost_group_idx" ON "mod_fundae_cost"("group_id");

-- CreateIndex
CREATE INDEX "mod_fundae_group_participant_group_status_idx" ON "mod_fundae_group_participant"("tenant_id", "group_id", "status");

-- CreateIndex
CREATE INDEX "mod_fundae_group_participant_company_status_idx" ON "mod_fundae_group_participant"("tenant_id", "company_id", "status");

-- CreateIndex
CREATE INDEX "mod_fundae_group_participant_tenant_user_idx" ON "mod_fundae_group_participant"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_fundae_group_participant_group_user_key" ON "mod_fundae_group_participant"("tenant_id", "group_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_token_hash_key" ON "password_reset_token"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_token_tenant_id_user_id_idx" ON "password_reset_token"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "password_reset_token_expires_at_idx" ON "password_reset_token"("expires_at");

-- CreateIndex
CREATE INDEX "email_verification_code_tenant_id_email_idx" ON "email_verification_code"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "email_verification_code_expires_at_idx" ON "email_verification_code"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "member_registration_decision_token_token_hash_key" ON "member_registration_decision_token"("token_hash");

-- CreateIndex
CREATE INDEX "member_registration_decision_token_tenant_id_user_id_idx" ON "member_registration_decision_token"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "member_registration_decision_token_expires_at_idx" ON "member_registration_decision_token"("expires_at");

-- CreateIndex
CREATE INDEX "member_payment_flag_tenant_id_is_delinquent_idx" ON "member_payment_flag"("tenant_id", "is_delinquent");

-- CreateIndex
CREATE UNIQUE INDEX "member_payment_flag_tenant_tg_key" ON "member_payment_flag"("tenant_id", "telegram_id");

-- CreateIndex
CREATE INDEX "member_subscription_lookup_tenant_id_idx" ON "member_subscription_lookup"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_subscription_lookup_tenant_user_key" ON "member_subscription_lookup"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "tenant_ai_provider_config_tenant_idx" ON "tenant_ai_provider_config"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_ai_provider_config_tenant_purpose_key" ON "tenant_ai_provider_config"("tenant_id", "purpose");

-- CreateIndex
CREATE INDEX "mod_ai_tutor_chunk_tenant_course_ordinal_idx" ON "mod_ai_tutor_chunk"("tenant_id", "course_id", "ordinal");

-- CreateIndex
CREATE INDEX "mod_ai_tutor_chunk_tenant_course_lesson_idx" ON "mod_ai_tutor_chunk"("tenant_id", "course_id", "lesson_id");

-- CreateIndex
CREATE INDEX "mod_ai_tutor_conversation_tenant_user_course_idx" ON "mod_ai_tutor_conversation"("tenant_id", "user_id", "course_id");

-- CreateIndex
CREATE INDEX "mod_ai_tutor_message_conv_created_idx" ON "mod_ai_tutor_message"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "mod_ai_tutor_message_tenant_role_created_idx" ON "mod_ai_tutor_message"("tenant_id", "role", "created_at");

-- CreateIndex
CREATE INDEX "mod_ai_tutor_message_tenant_review_idx" ON "mod_ai_tutor_message"("tenant_id", "review_status", "created_at");

-- CreateIndex
CREATE INDEX "mod_ai_tutor_correction_tenant_course_idx" ON "mod_ai_tutor_correction"("tenant_id", "course_id");

-- CreateIndex
CREATE INDEX "mod_ai_tutor_correction_tenant_active_idx" ON "mod_ai_tutor_correction"("tenant_id", "active");

-- CreateIndex
CREATE INDEX "mod_ai_tutor_token_usage_tenant_day_idx" ON "mod_ai_tutor_token_usage"("tenant_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "mod_ai_tutor_token_usage_tenant_user_day_key" ON "mod_ai_tutor_token_usage"("tenant_id", "user_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "mod_ai_grader_rubric_question_id_key" ON "mod_ai_grader_rubric"("question_id");

-- CreateIndex
CREATE INDEX "mod_ai_grader_rubric_tenant_idx" ON "mod_ai_grader_rubric"("tenant_id");

-- CreateIndex
CREATE INDEX "mod_ai_grader_suggestion_tenant_attempt_idx" ON "mod_ai_grader_suggestion"("tenant_id", "attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_ai_grader_suggestion_attempt_answer_key" ON "mod_ai_grader_suggestion"("attempt_id", "answer_id");

-- CreateIndex
CREATE UNIQUE INDEX "core_installation_registry_installation_id_key" ON "core_installation_registry"("installation_id");

-- CreateIndex
CREATE INDEX "mod_billing_product_tenant_id_course_id_active_idx" ON "mod_billing_product"("tenant_id", "course_id", "active");

-- CreateIndex
CREATE INDEX "mod_billing_product_tenant_id_active_idx" ON "mod_billing_product"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "mod_billing_product_tenant_id_course_id_name_key" ON "mod_billing_product"("tenant_id", "course_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "mod_billing_product_tenant_id_stripe_price_id_key" ON "mod_billing_product"("tenant_id", "stripe_price_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_billing_order_stripe_session_id_key" ON "mod_billing_order"("stripe_session_id");

-- CreateIndex
CREATE INDEX "mod_billing_order_tenant_id_user_id_idx" ON "mod_billing_order"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_billing_order_tenant_id_status_idx" ON "mod_billing_order"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_billing_order_course_id_idx" ON "mod_billing_order"("course_id");

-- CreateIndex
CREATE INDEX "mod_billing_order_stripe_payment_intent_id_idx" ON "mod_billing_order"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "mod_billing_webhook_event_type_idx" ON "mod_billing_webhook_event"("type");

-- CreateIndex
CREATE INDEX "mod_billing_webhook_event_tenant_id_received_at_idx" ON "mod_billing_webhook_event"("tenant_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "mod_subscriptions_subscription_stripe_subscription_id_key" ON "mod_subscriptions_subscription"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "mod_subscriptions_subscription_tenant_id_user_id_idx" ON "mod_subscriptions_subscription"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_subscriptions_subscription_tenant_id_status_idx" ON "mod_subscriptions_subscription"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_subscriptions_subscription_tenant_id_course_id_idx" ON "mod_subscriptions_subscription"("tenant_id", "course_id");

-- CreateIndex
CREATE INDEX "mod_subscriptions_subscription_tenant_id_plan_id_idx" ON "mod_subscriptions_subscription"("tenant_id", "plan_id");

-- CreateIndex
CREATE INDEX "mod_subscriptions_subscription_grace_period_ends_at_idx" ON "mod_subscriptions_subscription"("grace_period_ends_at");

-- CreateIndex
CREATE INDEX "mod_subscriptions_plan_tenant_id_active_sort_order_idx" ON "mod_subscriptions_plan"("tenant_id", "active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "mod_subscriptions_plan_tenant_id_name_key" ON "mod_subscriptions_plan"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "mod_subscriptions_invoice_stripe_invoice_id_key" ON "mod_subscriptions_invoice"("stripe_invoice_id");

-- CreateIndex
CREATE INDEX "mod_subscriptions_invoice_tenant_id_subscription_id_idx" ON "mod_subscriptions_invoice"("tenant_id", "subscription_id");

-- CreateIndex
CREATE INDEX "mod_subscriptions_invoice_tenant_id_status_idx" ON "mod_subscriptions_invoice"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_subscriptions_webhook_event_type_idx" ON "mod_subscriptions_webhook_event"("type");

-- CreateIndex
CREATE INDEX "mod_subscriptions_webhook_event_tenant_id_received_at_idx" ON "mod_subscriptions_webhook_event"("tenant_id", "received_at");

-- CreateIndex
CREATE INDEX "mod_payment_connections_connection_tenant_id_provider_idx" ON "mod_payment_connections_connection"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "mod_payment_connections_connection_tenant_id_status_idx" ON "mod_payment_connections_connection"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_conn_tenant_provider_name_key" ON "mod_payment_connections_connection"("tenant_id", "provider", "display_name");

-- CreateIndex
CREATE INDEX "mod_payment_connections_log_tenant_id_connection_id_idx" ON "mod_payment_connections_log"("tenant_id", "connection_id");

-- CreateIndex
CREATE INDEX "mod_payment_connections_tier_tenant_id_idx" ON "mod_payment_connections_tier"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_conn_tier_tenant_name_key" ON "mod_payment_connections_tier"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "mod_payment_connections_user_tier_tenant_id_idx" ON "mod_payment_connections_user_tier"("tenant_id");

-- CreateIndex
CREATE INDEX "mod_payment_connections_user_tier_manual_tier_id_idx" ON "mod_payment_connections_user_tier"("manual_tier_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_conn_user_tier_tenant_user_key" ON "mod_payment_connections_user_tier"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_payment_connections_subscriber_tenant_id_status_categor_idx" ON "mod_payment_connections_subscriber"("tenant_id", "status_category");

-- CreateIndex
CREATE INDEX "mod_payment_connections_subscriber_tenant_id_provider_idx" ON "mod_payment_connections_subscriber"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "mod_payment_connections_subscriber_tenant_id_user_id_idx" ON "mod_payment_connections_subscriber"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_conn_subscriber_unique" ON "mod_payment_connections_subscriber"("tenant_id", "connection_id", "subscription_id");

-- CreateIndex
CREATE INDEX "mod_payment_connections_order_tenant_id_user_id_idx" ON "mod_payment_connections_order"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_payment_connections_order_tenant_id_customer_email_idx" ON "mod_payment_connections_order"("tenant_id", "customer_email");

-- CreateIndex
CREATE INDEX "mod_payment_connections_order_tenant_id_entitlement_kind_idx" ON "mod_payment_connections_order"("tenant_id", "entitlement_kind");

-- CreateIndex
CREATE INDEX "mod_payment_connections_order_tenant_id_access_ends_at_idx" ON "mod_payment_connections_order"("tenant_id", "access_ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_conn_order_unique" ON "mod_payment_connections_order"("tenant_id", "provider", "external_id");

-- CreateIndex
CREATE INDEX "mod_payment_connections_sync_history_tenant_id_connection_i_idx" ON "mod_payment_connections_sync_history"("tenant_id", "connection_id", "completed_at");

-- CreateIndex
CREATE INDEX "mod_ai_content_draft_tenant_id_lesson_id_idx" ON "mod_ai_content_draft"("tenant_id", "lesson_id");

-- CreateIndex
CREATE INDEX "mod_ai_content_draft_tenant_id_status_idx" ON "mod_ai_content_draft"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_ai_content_draft_course_id_idx" ON "mod_ai_content_draft"("course_id");

-- CreateIndex
CREATE UNIQUE INDEX "installed_module_name_key" ON "installed_module"("name");

-- CreateIndex
CREATE INDEX "installed_module_status_idx" ON "installed_module"("status");

-- CreateIndex
CREATE INDEX "installed_module_vendor_idx" ON "installed_module"("vendor");

-- CreateIndex
CREATE INDEX "mod_secret_expires_at_idx" ON "mod_secret"("expires_at");

-- CreateIndex
CREATE INDEX "mod_secret_tenant_id_module_id_idx" ON "mod_secret"("tenant_id", "module_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_secret_tenant_id_module_id_secret_key_key" ON "mod_secret"("tenant_id", "module_id", "secret_key");

-- CreateIndex
CREATE INDEX "mod_group_tenant_id_deleted_at_idx" ON "mod_group"("tenant_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "mod_group_tenant_slug_key" ON "mod_group"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "mod_group_member_tenant_id_user_id_idx" ON "mod_group_member"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_group_member_unique" ON "mod_group_member"("group_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_event_tenant_id_start_at_deleted_at_idx" ON "mod_event"("tenant_id", "start_at", "deleted_at");

-- CreateIndex
CREATE INDEX "mod_event_registration_tenant_id_user_id_idx" ON "mod_event_registration"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_event_registration_unique" ON "mod_event_registration"("event_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_access_groups_group_tenant_id_deleted_at_idx" ON "mod_access_groups_group"("tenant_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "mod_access_groups_group_tenant_slug_key" ON "mod_access_groups_group"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "mod_access_groups_group_course_tenant_id_course_id_idx" ON "mod_access_groups_group_course"("tenant_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_access_groups_group_course_unique" ON "mod_access_groups_group_course"("group_id", "course_id");

-- CreateIndex
CREATE INDEX "mod_access_groups_group_member_tenant_id_user_id_idx" ON "mod_access_groups_group_member"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_access_groups_member_unique" ON "mod_access_groups_group_member"("group_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_access_groups_grant_tenant_id_user_id_course_id_idx" ON "mod_access_groups_grant"("tenant_id", "user_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_access_groups_grant_unique" ON "mod_access_groups_grant"("tenant_id", "group_id", "user_id", "course_id");

-- CreateIndex
CREATE INDEX "mod_learning_path_tenant_id_status_idx" ON "mod_learning_path"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_path_tenant_id_slug_key" ON "mod_learning_path"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "mod_learning_path_course_path_id_position_idx" ON "mod_learning_path_course"("path_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_path_course_path_id_course_id_key" ON "mod_learning_path_course"("path_id", "course_id");

-- CreateIndex
CREATE INDEX "mod_learning_path_enrollment_tenant_id_user_id_status_idx" ON "mod_learning_path_enrollment"("tenant_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "mod_learning_path_enrollment_path_id_idx" ON "mod_learning_path_enrollment"("path_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_path_enrollment_tenant_id_path_id_user_id_key" ON "mod_learning_path_enrollment"("tenant_id", "path_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_learning_competency_tenant_id_sort_order_idx" ON "mod_learning_competency"("tenant_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_competency_tenant_id_name_key" ON "mod_learning_competency"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "mod_learning_course_competency_tenant_id_course_id_idx" ON "mod_learning_course_competency"("tenant_id", "course_id");

-- CreateIndex
CREATE INDEX "mod_learning_course_competency_competency_id_idx" ON "mod_learning_course_competency"("competency_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_course_competency_tenant_id_course_id_competen_key" ON "mod_learning_course_competency"("tenant_id", "course_id", "competency_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_referrals_code_tenant_id_user_id_key" ON "mod_referrals_code"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_referrals_code_tenant_id_code_key" ON "mod_referrals_code"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "mod_referrals_click_tenant_id_code_id_idx" ON "mod_referrals_click"("tenant_id", "code_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_referrals_click_code_id_day_ip_hash_key" ON "mod_referrals_click"("code_id", "day", "ip_hash");

-- CreateIndex
CREATE UNIQUE INDEX "mod_referrals_referral_stripe_subscription_id_key" ON "mod_referrals_referral"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "mod_referrals_referral_tenant_id_referrer_user_id_idx" ON "mod_referrals_referral"("tenant_id", "referrer_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_referrals_referral_tenant_id_referred_user_id_key" ON "mod_referrals_referral"("tenant_id", "referred_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_referrals_commission_stripe_invoice_id_key" ON "mod_referrals_commission"("stripe_invoice_id");

-- CreateIndex
CREATE INDEX "mod_referrals_commission_tenant_id_referrer_user_id_status_idx" ON "mod_referrals_commission"("tenant_id", "referrer_user_id", "status");

-- CreateIndex
CREATE INDEX "mod_referrals_commission_tenant_id_status_idx" ON "mod_referrals_commission"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_referrals_commission_status_approve_after_idx" ON "mod_referrals_commission"("status", "approve_after");

-- CreateIndex
CREATE INDEX "mod_referrals_payout_tenant_id_referrer_user_id_idx" ON "mod_referrals_payout"("tenant_id", "referrer_user_id");

-- CreateIndex
CREATE INDEX "mod_messaging_conversation_tenant_id_type_last_message_at_idx" ON "mod_messaging_conversation"("tenant_id", "type", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "mod_messaging_conversation_tenant_id_dm_key_key" ON "mod_messaging_conversation"("tenant_id", "dm_key");

-- CreateIndex
CREATE UNIQUE INDEX "mod_messaging_conversation_tenant_id_space_id_key" ON "mod_messaging_conversation"("tenant_id", "space_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_messaging_conversation_tenant_id_student_id_key" ON "mod_messaging_conversation"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "mod_messaging_participant_tenant_id_user_id_idx" ON "mod_messaging_participant"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_messaging_participant_conversation_id_user_id_key" ON "mod_messaging_participant"("conversation_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_messaging_message_tenant_id_conversation_id_created_at_idx" ON "mod_messaging_message"("tenant_id", "conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "mod_surveys_survey_tenant_id_kind_created_at_idx" ON "mod_surveys_survey"("tenant_id", "kind", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mod_surveys_survey_tenant_id_zoom_session_id_key" ON "mod_surveys_survey"("tenant_id", "zoom_session_id");

-- CreateIndex
CREATE INDEX "mod_surveys_question_tenant_id_survey_id_idx" ON "mod_surveys_question"("tenant_id", "survey_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_surveys_question_survey_id_position_key" ON "mod_surveys_question"("survey_id", "position");

-- CreateIndex
CREATE INDEX "mod_surveys_response_tenant_id_survey_id_idx" ON "mod_surveys_response"("tenant_id", "survey_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_surveys_response_survey_id_respondent_hash_key" ON "mod_surveys_response"("survey_id", "respondent_hash");

-- CreateIndex
CREATE INDEX "mod_surveys_answer_tenant_id_question_id_idx" ON "mod_surveys_answer"("tenant_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_surveys_answer_response_id_question_id_key" ON "mod_surveys_answer"("response_id", "question_id");

-- CreateIndex
CREATE INDEX "mod_resources_collection_tenant_id_sort_order_idx" ON "mod_resources_collection"("tenant_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "mod_resources_collection_tenant_id_title_key" ON "mod_resources_collection"("tenant_id", "title");

-- CreateIndex
CREATE INDEX "mod_resources_resource_tenant_id_collection_id_created_at_idx" ON "mod_resources_resource"("tenant_id", "collection_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mod_gamification_ledger_entry_tenant_id_user_id_revoked_at_idx" ON "mod_gamification_ledger_entry"("tenant_id", "user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "mod_gamification_ledger_entry_tenant_id_occurred_at_idx" ON "mod_gamification_ledger_entry"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "mod_gamification_ledger_entry_tenant_id_rule_key_user_id_oc_idx" ON "mod_gamification_ledger_entry"("tenant_id", "rule_key", "user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_ledger_entry_tenant_id_user_id_source_key_key" ON "mod_gamification_ledger_entry"("tenant_id", "user_id", "source_key");

-- CreateIndex
CREATE INDEX "mod_gamification_profile_tenant_id_lifetime_points_idx" ON "mod_gamification_profile"("tenant_id", "lifetime_points" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_profile_tenant_id_user_id_key" ON "mod_gamification_profile"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_rule_tenant_id_key_key" ON "mod_gamification_rule"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "mod_gamification_level_tenant_id_min_points_idx" ON "mod_gamification_level"("tenant_id", "min_points");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_level_tenant_id_key_key" ON "mod_gamification_level"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_level_tenant_id_min_points_key" ON "mod_gamification_level"("tenant_id", "min_points");

-- CreateIndex
CREATE INDEX "mod_gamification_perk_tenant_id_level_id_idx" ON "mod_gamification_perk"("tenant_id", "level_id");

-- CreateIndex
CREATE INDEX "mod_gamification_perk_request_tenant_id_status_created_at_idx" ON "mod_gamification_perk_request"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mod_gamification_perk_request_tenant_id_user_id_perk_id_idx" ON "mod_gamification_perk_request"("tenant_id", "user_id", "perk_id");

-- CreateIndex
CREATE INDEX "mod_gamification_challenge_tenant_id_status_created_at_idx" ON "mod_gamification_challenge"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mod_gamification_submission_tenant_id_status_created_at_idx" ON "mod_gamification_submission"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mod_gamification_submission_tenant_id_user_id_idx" ON "mod_gamification_submission"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_submission_tenant_id_challenge_id_user_id_key" ON "mod_gamification_submission"("tenant_id", "challenge_id", "user_id");

-- AddForeignKey
ALTER TABLE "tenant_domain" ADD CONSTRAINT "tenant_domain_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_setting" ADD CONSTRAINT "tenant_setting_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_module" ADD CONSTRAINT "tenant_module_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_module" ADD CONSTRAINT "tenant_module_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_restriction" ADD CONSTRAINT "user_restriction_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_external_identity" ADD CONSTRAINT "user_external_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_dead_letter" ADD CONSTRAINT "webhook_dead_letter_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_community_comment" ADD CONSTRAINT "mod_community_comment_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "mod_community_post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_community_comment" ADD CONSTRAINT "mod_community_comment_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "mod_community_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_community_reaction" ADD CONSTRAINT "mod_community_reaction_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "mod_community_post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_community_reaction" ADD CONSTRAINT "mod_community_reaction_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "mod_community_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "mod_zoom_session_registration" ADD CONSTRAINT "mod_zoom_session_registration_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "mod_zoom_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_zoom_session_attendance" ADD CONSTRAINT "mod_zoom_session_attendance_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "mod_zoom_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_fundae_rlpt_notice" ADD CONSTRAINT "mod_fundae_rlpt_notice_evidence_entry_id_fkey" FOREIGN KEY ("evidence_entry_id") REFERENCES "evidence_vault_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_fundae_cost" ADD CONSTRAINT "mod_fundae_cost_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "mod_fundae_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_fundae_group_participant" ADD CONSTRAINT "mod_fundae_group_participant_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "mod_fundae_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_ai_tutor_message" ADD CONSTRAINT "mod_ai_tutor_message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mod_ai_tutor_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_subscriptions_invoice" ADD CONSTRAINT "fk_mod_subs_invoice_subscription" FOREIGN KEY ("subscription_id") REFERENCES "mod_subscriptions_subscription"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_payment_connections_user_tier" ADD CONSTRAINT "fk_pc_user_tier_manual" FOREIGN KEY ("manual_tier_id") REFERENCES "mod_payment_connections_tier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_group_member" ADD CONSTRAINT "mod_group_member_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "mod_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_event_registration" ADD CONSTRAINT "mod_event_registration_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "mod_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_access_groups_group_course" ADD CONSTRAINT "mod_access_groups_group_course_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "mod_access_groups_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_access_groups_group_member" ADD CONSTRAINT "mod_access_groups_group_member_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "mod_access_groups_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_learning_path_course" ADD CONSTRAINT "mod_learning_path_course_path_id_fkey" FOREIGN KEY ("path_id") REFERENCES "mod_learning_path"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_learning_path_enrollment" ADD CONSTRAINT "mod_learning_path_enrollment_path_id_fkey" FOREIGN KEY ("path_id") REFERENCES "mod_learning_path"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_learning_course_competency" ADD CONSTRAINT "mod_learning_course_competency_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "mod_learning_competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_referrals_click" ADD CONSTRAINT "mod_referrals_click_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "mod_referrals_code"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_referrals_commission" ADD CONSTRAINT "mod_referrals_commission_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "mod_referrals_referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_referrals_commission" ADD CONSTRAINT "mod_referrals_commission_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "mod_referrals_payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_messaging_participant" ADD CONSTRAINT "mod_messaging_participant_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mod_messaging_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_messaging_message" ADD CONSTRAINT "mod_messaging_message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mod_messaging_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_surveys_question" ADD CONSTRAINT "mod_surveys_question_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "mod_surveys_survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_surveys_response" ADD CONSTRAINT "mod_surveys_response_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "mod_surveys_survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_surveys_answer" ADD CONSTRAINT "mod_surveys_answer_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "mod_surveys_response"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_surveys_answer" ADD CONSTRAINT "mod_surveys_answer_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "mod_surveys_question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_resources_resource" ADD CONSTRAINT "mod_resources_resource_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "mod_resources_collection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_gamification_perk" ADD CONSTRAINT "mod_gamification_perk_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "mod_gamification_level"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_gamification_perk_request" ADD CONSTRAINT "mod_gamification_perk_request_perk_id_fkey" FOREIGN KEY ("perk_id") REFERENCES "mod_gamification_perk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_gamification_submission" ADD CONSTRAINT "mod_gamification_submission_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "mod_gamification_challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

