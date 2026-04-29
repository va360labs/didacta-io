-- mod.fundae: empresa bonificada que financia la formación con crédito
-- Fundae. Base de LMS-79 y prerequisito de LMS-80/81/82/83/84.
CREATE TABLE "mod_fundae_company" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "nif" VARCHAR(20) NOT NULL,
  "razon_social" VARCHAR(200) NOT NULL,
  "ccc_principal" VARCHAR(15),
  "plantilla" INTEGER,
  "credito_total_cents" INTEGER,
  "credito_usado_cents" INTEGER NOT NULL DEFAULT 0,
  "datos_contacto" JSONB NOT NULL DEFAULT '{}',
  "notas" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "mod_fundae_company_pkey" PRIMARY KEY ("id")
);

-- NIF único por tenant (DNI/NIE/CIF normalizado en mayúsculas, sin
-- separadores). El service normaliza antes de insertar.
CREATE UNIQUE INDEX "mod_fundae_company_tenant_nif_key"
  ON "mod_fundae_company"("tenant_id", "nif");

-- Lookup principal: empresas vivas de un tenant.
CREATE INDEX "mod_fundae_company_tenant_deleted_idx"
  ON "mod_fundae_company"("tenant_id", "deleted_at");

-- Búsqueda por razón social (case-sensitive — el frontend ya lo
-- normaliza al filtrar).
CREATE INDEX "mod_fundae_company_tenant_razon_idx"
  ON "mod_fundae_company"("tenant_id", "razon_social");
