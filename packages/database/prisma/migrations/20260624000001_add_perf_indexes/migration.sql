-- Índices de rendimiento.
-- 1) Feed de comunidad: filtro por tag (`tags @> ARRAY[...]`) sin índice = seq scan.
CREATE INDEX IF NOT EXISTS "mod_community_post_tags_idx" ON "mod_community_post" USING GIN ("tags");

-- 2) Progreso de lección por inscripción (carga del player).
CREATE INDEX IF NOT EXISTS "mod_learning_progress_tenant_id_enrollment_id_idx"
  ON "mod_learning_progress" ("tenant_id", "enrollment_id");
