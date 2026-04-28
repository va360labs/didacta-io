-- mod.community: permite a admins fijar (pin) un post para que vaya al tope
-- del feed independientemente del orden elegido. El audit de quién fijó queda
-- en pinned_by_id (sin FK a IAM por la regla de no-cross-module FK).
ALTER TABLE "mod_community_post"
  ADD COLUMN "pinned_at" TIMESTAMP(3),
  ADD COLUMN "pinned_by_id" UUID;

-- Index parcial sobre pinned_at: solo indexa filas pinneadas, que serán
-- pocas. Acelera el sort `pinnedAt DESC` que el listado aplica antes que
-- el orderBy del usuario.
CREATE INDEX "mod_community_post_tenant_id_pinned_at_idx"
  ON "mod_community_post"("tenant_id", "pinned_at");
