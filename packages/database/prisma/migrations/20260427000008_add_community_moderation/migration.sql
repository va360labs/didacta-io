-- mod.community v0.2: moderación de posts y comments por tenant_admin.
-- hidden_at != null oculta para alumnos pero preserva la fila.
ALTER TABLE "mod_community_post"
  ADD COLUMN "hidden_at" TIMESTAMP(3),
  ADD COLUMN "hidden_by_id" UUID,
  ADD COLUMN "hidden_reason" TEXT;

ALTER TABLE "mod_community_comment"
  ADD COLUMN "hidden_at" TIMESTAMP(3),
  ADD COLUMN "hidden_by_id" UUID,
  ADD COLUMN "hidden_reason" TEXT;
