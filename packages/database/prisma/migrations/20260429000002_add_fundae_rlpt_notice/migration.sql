-- mod.fundae.rlpt: notificaciones a la Representación Legal de Personas
-- Trabajadoras (LMS-80). Cada grupo bonificable necesita NOTIFICACION_INICIAL
-- con `plazo_vencimiento_at` cumplido para poder iniciarse (15 días
-- naturales de antelación según RD 694/2017).
CREATE TABLE "mod_fundae_rlpt_notice" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "tipo" TEXT NOT NULL,
  "fecha_notificacion_at" TIMESTAMP(3) NOT NULL,
  "plazo_vencimiento_at" TIMESTAMP(3) NOT NULL,
  "evidence_entry_id" UUID NOT NULL,
  "observaciones" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "mod_fundae_rlpt_notice_pkey" PRIMARY KEY ("id")
);

-- FK física al Evidence Vault: el blob debe seguir vivo mientras la
-- notificación exista. Las FKs cross-module (a mod_fundae_company)
-- las omitimos por la regla del proyecto.
ALTER TABLE "mod_fundae_rlpt_notice"
  ADD CONSTRAINT "mod_fundae_rlpt_notice_evidence_fk"
  FOREIGN KEY ("evidence_entry_id") REFERENCES "evidence_vault_entry"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Listados típicos: por (empresa, tipo) y por (empresa) ordenado por
-- fecha descendente para mostrar el histórico en la UI.
CREATE INDEX "mod_fundae_rlpt_tenant_company_tipo_idx"
  ON "mod_fundae_rlpt_notice"("tenant_id", "company_id", "tipo");

CREATE INDEX "mod_fundae_rlpt_tenant_company_fecha_idx"
  ON "mod_fundae_rlpt_notice"("tenant_id", "company_id", "fecha_notificacion_at" DESC);

CREATE INDEX "mod_fundae_rlpt_evidence_idx"
  ON "mod_fundae_rlpt_notice"("evidence_entry_id");
