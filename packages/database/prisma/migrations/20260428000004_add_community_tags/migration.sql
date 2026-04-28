-- mod.community: tags curados por admin con metadata visual (color e icono).
-- La columna `tags` de mod_community_post sigue siendo libre; esta tabla
-- añade metadata opcional para los tags "oficiales" del tenant.
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

-- Único por (tenant, name) para evitar duplicados. La app normaliza a
-- minúsculas antes de insertar para que "Ayuda" y "ayuda" colisionen.
CREATE UNIQUE INDEX "mod_community_tag_tenant_name_key"
  ON "mod_community_tag"("tenant_id", "name");

CREATE INDEX "mod_community_tag_tenant_id_idx" ON "mod_community_tag"("tenant_id");
