-- HU-FOR-002: import de paquetes SCORM 1.2 / 2004 como tipo de lección.

-- 1. Añadir SCORM al enum LessonType.
ALTER TYPE "LessonType" ADD VALUE IF NOT EXISTS 'SCORM';

-- 2. Tabla mod_learning_scorm_package: 1:1 con lección de tipo SCORM.
CREATE TABLE "mod_learning_scorm_package" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"      UUID NOT NULL,
  "lesson_id"      UUID NOT NULL,
  "version"        TEXT NOT NULL,
  "entry_path"     TEXT NOT NULL,
  "storage_prefix" TEXT NOT NULL,
  "manifest"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "size"           INTEGER NOT NULL,
  "uploaded_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploaded_by_id" UUID
);

CREATE UNIQUE INDEX "mod_learning_scorm_package_lesson_id_key"
  ON "mod_learning_scorm_package" ("lesson_id");
CREATE INDEX "mod_learning_scorm_package_tenant_id_idx"
  ON "mod_learning_scorm_package" ("tenant_id");
