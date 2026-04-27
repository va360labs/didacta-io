-- mod.community: preferencias de notificación por usuario.
-- v0.1: solo digest_opt_out. Estructura abierta para sumar prefs (mentions
-- in-app, replies push, etc.) sin requerir nuevas migraciones.
CREATE TABLE "mod_community_user_pref" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "digest_opt_out" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mod_community_user_pref_pkey" PRIMARY KEY ("id")
);

-- Un par (tenant, user) único: solo una fila de prefs por usuario.
CREATE UNIQUE INDEX "mod_community_user_pref_tenant_user_key"
  ON "mod_community_user_pref"("tenant_id", "user_id");
