-- CreateEnum
CREATE TYPE "LearningPathStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LearningPathSequenceType" AS ENUM ('LINEAR', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "LearningPathEnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

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

-- AddForeignKey
ALTER TABLE "mod_learning_path_course" ADD CONSTRAINT "mod_learning_path_course_path_id_fkey" FOREIGN KEY ("path_id") REFERENCES "mod_learning_path"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_learning_path_enrollment" ADD CONSTRAINT "mod_learning_path_enrollment_path_id_fkey" FOREIGN KEY ("path_id") REFERENCES "mod_learning_path"("id") ON DELETE CASCADE ON UPDATE CASCADE;
