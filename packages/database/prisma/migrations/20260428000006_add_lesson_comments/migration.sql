-- mod.learning: comentarios/anotaciones del alumno en una lección con
-- aprobación del profesor antes de ser visibles al resto.
CREATE TYPE "LessonCommentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

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

CREATE INDEX "mod_learning_lesson_comment_tenant_lesson_status_idx"
  ON "mod_learning_lesson_comment"("tenant_id", "lesson_id", "status");
CREATE INDEX "mod_learning_lesson_comment_tenant_course_status_idx"
  ON "mod_learning_lesson_comment"("tenant_id", "course_id", "status");
CREATE INDEX "mod_learning_lesson_comment_tenant_author_status_idx"
  ON "mod_learning_lesson_comment"("tenant_id", "author_id", "status");
