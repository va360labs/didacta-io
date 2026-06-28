-- DRIP de lecciones + vínculo Tier↔Grupo de acceso
-- Ver PRD "DRIP de lecciones por tier/grupo + vínculo Tier↔Grupo de acceso".

-- CreateEnum
CREATE TYPE "DripAudienceKind" AS ENUM ('TIER', 'GROUP');

-- CreateEnum
CREATE TYPE "DripUnit" AS ENUM ('LESSON', 'MODULE');

-- AlterTable: vínculo opcional grupo→tier (acople débil por nombre)
ALTER TABLE "mod_access_groups_group" ADD COLUMN "linked_tier_name" TEXT;

-- AlterTable: origen de la membresía (MANUAL | TIER) para no pisar altas manuales
ALTER TABLE "mod_access_groups_group_member" ADD COLUMN "source" VARCHAR(20) NOT NULL DEFAULT 'MANUAL';

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

-- CreateIndex
CREATE UNIQUE INDEX "mod_learning_drip_schedule_unique" ON "mod_learning_drip_schedule"("tenant_id", "course_id", "audience_kind", "audience_ref");

-- CreateIndex
CREATE INDEX "mod_learning_drip_schedule_tenant_id_course_id_idx" ON "mod_learning_drip_schedule"("tenant_id", "course_id");
