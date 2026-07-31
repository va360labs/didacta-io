-- ============================================================================
-- D13 F1 — datos del vertical inscripción → mod.member-registration
-- ----------------------------------------------------------------------------
-- 1) Renombra las 3 tablas del vertical al prefijo de módulo
--    mod_member_registration_* (contrato ADR-016), junto con sus índices y
--    constraints para que coincidan con los nombres que Prisma espera del
--    schema (sin deriva en `migrate diff`).
-- 2) Crea mod_member_registration_profile: extrae de `user` los datos propios
--    del flujo (telegram_id, telegram_in_group, approval_decided_at) — un
--    módulo no puede escribir columnas de tablas core. Copia los datos
--    existentes. Las columnas de `user` quedan DEPRECADAS (dual-write durante
--    la transición) y se eliminarán en la fase final (D13 F4) cuando ninguna
--    instalación las lea.
--
-- NO destructivo: solo renames + tabla nueva + copia. Reversible con renames
-- inversos.
-- ============================================================================

-- 1) decision_token ----------------------------------------------------------
ALTER TABLE "member_registration_decision_token"
  RENAME TO "mod_member_registration_decision_token";
ALTER TABLE "mod_member_registration_decision_token"
  RENAME CONSTRAINT "member_registration_decision_token_pkey"
  TO "mod_member_registration_decision_token_pkey";
ALTER INDEX "member_registration_decision_token_token_hash_key"
  RENAME TO "mod_member_registration_decision_token_token_hash_key";
ALTER INDEX "member_registration_decision_token_tenant_id_user_id_idx"
  RENAME TO "mod_member_registration_decision_token_tenant_user_idx";
ALTER INDEX "member_registration_decision_token_expires_at_idx"
  RENAME TO "mod_member_registration_decision_token_expires_at_idx";

-- 2) payment_flag -------------------------------------------------------------
ALTER TABLE "member_payment_flag"
  RENAME TO "mod_member_registration_payment_flag";
ALTER TABLE "mod_member_registration_payment_flag"
  RENAME CONSTRAINT "member_payment_flag_pkey"
  TO "mod_member_registration_payment_flag_pkey";
ALTER INDEX "member_payment_flag_tenant_tg_key"
  RENAME TO "mod_member_registration_payment_flag_tenant_tg_key";
ALTER INDEX "member_payment_flag_tenant_id_is_delinquent_idx"
  RENAME TO "mod_member_registration_payment_flag_tenant_delinq_idx";

-- 3) subscription_lookup ------------------------------------------------------
ALTER TABLE "member_subscription_lookup"
  RENAME TO "mod_member_registration_subscription_lookup";
ALTER TABLE "mod_member_registration_subscription_lookup"
  RENAME CONSTRAINT "member_subscription_lookup_pkey"
  TO "mod_member_registration_subscription_lookup_pkey";
ALTER INDEX "member_subscription_lookup_tenant_user_key"
  RENAME TO "mod_member_registration_subscription_lookup_tenant_user_key";
ALTER INDEX "member_subscription_lookup_tenant_id_idx"
  RENAME TO "mod_member_registration_subscription_lookup_tenant_idx";

-- 4) profile ------------------------------------------------------------------
CREATE TABLE "mod_member_registration_profile" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "telegram_id" VARCHAR(32),
  "telegram_in_group" BOOLEAN,
  "approval_decided_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mod_member_registration_profile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_member_registration_profile_tenant_id_user_id_key"
  ON "mod_member_registration_profile" ("tenant_id", "user_id");
CREATE INDEX "mod_member_registration_profile_tenant_id_telegram_id_idx"
  ON "mod_member_registration_profile" ("tenant_id", "telegram_id");

-- Copia: solo usuarios tocados por el flujo (algún campo del vertical set).
-- id = user_id (1:1) — evita depender de extensiones para generar UUIDs.
INSERT INTO "mod_member_registration_profile"
  ("id", "tenant_id", "user_id", "telegram_id", "telegram_in_group",
   "approval_decided_at", "created_at", "updated_at")
SELECT "id", "tenant_id", "id", "telegram_id", "telegram_in_group",
       "approval_decided_at", "created_at", "updated_at"
FROM "user"
WHERE "telegram_id" IS NOT NULL OR "approval_decided_at" IS NOT NULL;
