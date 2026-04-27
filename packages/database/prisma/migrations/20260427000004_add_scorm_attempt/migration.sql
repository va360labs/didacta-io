-- SCORM API runtime: persiste cmi.* por (user, lesson) para reanudación.

CREATE TABLE "mod_learning_scorm_attempt" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         UUID NOT NULL,
  "user_id"           UUID NOT NULL,
  "lesson_id"         UUID NOT NULL,
  "package_id"        UUID NOT NULL,
  "cmi_data"          JSONB NOT NULL DEFAULT '{}'::jsonb,
  "completion_status" TEXT,
  "score_scaled"      DOUBLE PRECISION,
  "started_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_accessed_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"      TIMESTAMP(3)
);

CREATE UNIQUE INDEX "mod_learning_scorm_attempt_user_lesson_key"
  ON "mod_learning_scorm_attempt" ("user_id", "lesson_id");
CREATE INDEX "mod_learning_scorm_attempt_tenant_user_idx"
  ON "mod_learning_scorm_attempt" ("tenant_id", "user_id");
CREATE INDEX "mod_learning_scorm_attempt_tenant_lesson_idx"
  ON "mod_learning_scorm_attempt" ("tenant_id", "lesson_id");
