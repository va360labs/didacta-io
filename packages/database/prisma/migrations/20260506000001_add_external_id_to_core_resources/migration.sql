-- Migration: 20260506000001_add_external_id_to_core_resources
-- Sprint 2 / DD-000 / ADR-014.
--
-- Añade dos columnas opcionales `external_source` + `external_id` a los
-- recursos del core que pueden ser importados por módulos third-party
-- (migrators de LearnDash, Moodle, Thinkific, etc.). Forman juntos la
-- clave de idempotencia que `ctx.didacta.<recurso>.upsertByExternalRef`
-- usa para evitar duplicados.
--
-- - `external_source` (VARCHAR(40)) — slug del origen, lower-snake-case.
--   Coincide con `manifest.didacta.externalSource`. Ej. "learndash".
-- - `external_id` (VARCHAR(200)) — ID del recurso en el sistema origen.
--   Free-form, opaque para el core. Ej. "1234" (WP post_id).
--
-- Ambas columnas son NULLable: TODOS los users/cursos/lecciones/etc. ya
-- existentes y todos los recursos creados directamente en Didacta tienen
-- ambos = NULL. Sin backfill (no hay datos legacy).
--
-- Idempotencia tenant-aware vía UNIQUE INDEX con WHERE clause: solo aplica
-- cuando ambos campos están NOT NULL. Esto permite que el módulo importe
-- N usuarios sin externalId (ej. tests) y simultáneamente N usuarios con
-- externalId (la importación real) — solo los del segundo grupo deben ser
-- únicos por (tenant_id, external_source, external_id). El index no-unique
-- de respaldo (`*_external_ref_idx`) declarado en schema.prisma cubre
-- lookups vía findByExternalRef. Mantenemos los dos: uno para enforce
-- (UNIQUE WHERE) y otro para query (sin filtro).

-- ── User ────────────────────────────────────────────────────────────────────
ALTER TABLE "user"
  ADD COLUMN "external_source" VARCHAR(40),
  ADD COLUMN "external_id"     VARCHAR(200);

CREATE INDEX "user_external_ref_idx"
  ON "user" ("tenant_id", "external_source", "external_id");

CREATE UNIQUE INDEX "user_external_ref_unique"
  ON "user" ("tenant_id", "external_source", "external_id")
  WHERE "external_source" IS NOT NULL AND "external_id" IS NOT NULL AND "deleted_at" IS NULL;

-- ── ModCoursesCourse ────────────────────────────────────────────────────────
ALTER TABLE "mod_courses_course"
  ADD COLUMN "external_source" VARCHAR(40),
  ADD COLUMN "external_id"     VARCHAR(200);

CREATE INDEX "mod_courses_course_external_ref_idx"
  ON "mod_courses_course" ("tenant_id", "external_source", "external_id");

CREATE UNIQUE INDEX "mod_courses_course_external_ref_unique"
  ON "mod_courses_course" ("tenant_id", "external_source", "external_id")
  WHERE "external_source" IS NOT NULL AND "external_id" IS NOT NULL AND "deleted_at" IS NULL;

-- ── ModCoursesModule ────────────────────────────────────────────────────────
ALTER TABLE "mod_courses_module"
  ADD COLUMN "external_source" VARCHAR(40),
  ADD COLUMN "external_id"     VARCHAR(200);

CREATE INDEX "mod_courses_module_external_ref_idx"
  ON "mod_courses_module" ("tenant_id", "external_source", "external_id");

CREATE UNIQUE INDEX "mod_courses_module_external_ref_unique"
  ON "mod_courses_module" ("tenant_id", "external_source", "external_id")
  WHERE "external_source" IS NOT NULL AND "external_id" IS NOT NULL AND "deleted_at" IS NULL;

-- ── ModCoursesLesson ────────────────────────────────────────────────────────
ALTER TABLE "mod_courses_lesson"
  ADD COLUMN "external_source" VARCHAR(40),
  ADD COLUMN "external_id"     VARCHAR(200);

CREATE INDEX "mod_courses_lesson_external_ref_idx"
  ON "mod_courses_lesson" ("tenant_id", "external_source", "external_id");

CREATE UNIQUE INDEX "mod_courses_lesson_external_ref_unique"
  ON "mod_courses_lesson" ("tenant_id", "external_source", "external_id")
  WHERE "external_source" IS NOT NULL AND "external_id" IS NOT NULL AND "deleted_at" IS NULL;

-- ── ModLearningEnrollment ───────────────────────────────────────────────────
-- Nota: enrollment NO tiene `deleted_at` (usa `cancelled_at` para soft-cancel).
-- Por eso el WHERE solo filtra sobre external_source/external_id NOT NULL.
ALTER TABLE "mod_learning_enrollment"
  ADD COLUMN "external_source" VARCHAR(40),
  ADD COLUMN "external_id"     VARCHAR(200);

CREATE INDEX "mod_learning_enrollment_external_ref_idx"
  ON "mod_learning_enrollment" ("tenant_id", "external_source", "external_id");

CREATE UNIQUE INDEX "mod_learning_enrollment_external_ref_unique"
  ON "mod_learning_enrollment" ("tenant_id", "external_source", "external_id")
  WHERE "external_source" IS NOT NULL AND "external_id" IS NOT NULL;

-- ── ModAssessmentsQuiz ──────────────────────────────────────────────────────
ALTER TABLE "mod_assessments_quiz"
  ADD COLUMN "external_source" VARCHAR(40),
  ADD COLUMN "external_id"     VARCHAR(200);

CREATE INDEX "mod_assessments_quiz_external_ref_idx"
  ON "mod_assessments_quiz" ("tenant_id", "external_source", "external_id");

CREATE UNIQUE INDEX "mod_assessments_quiz_external_ref_unique"
  ON "mod_assessments_quiz" ("tenant_id", "external_source", "external_id")
  WHERE "external_source" IS NOT NULL AND "external_id" IS NOT NULL AND "deleted_at" IS NULL;
