-- mod.fundae: grupo bonificable + desglose de costes (LMS-81). Sobre los
-- prerequisitos de empresa (LMS-79) y RLPT (LMS-80), el grupo materializa
-- el ciclo de vida DRAFT → ACTIVE → CLOSED y consolida los costes que
-- Fundae exige por categoría.
CREATE TABLE "mod_fundae_group" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "action_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "numero_grupo" INTEGER NOT NULL,
  "modalidad" TEXT NOT NULL,
  "fecha_inicio_prevista" TIMESTAMP(3) NOT NULL,
  "fecha_fin_prevista" TIMESTAMP(3) NOT NULL,
  "fecha_inicio_real" TIMESTAMP(3),
  "fecha_fin_real" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "credito_estimado_cents" INTEGER,
  "notas" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mod_fundae_group_pkey" PRIMARY KEY ("id")
);

-- Numero de grupo único por (tenant, accion). Permite que dos acciones
-- distintas tengan ambas un grupo "1" sin colisión.
CREATE UNIQUE INDEX "mod_fundae_group_action_numero_key"
  ON "mod_fundae_group"("tenant_id", "action_id", "numero_grupo");

-- Lookups habituales en la UI.
CREATE INDEX "mod_fundae_group_tenant_company_status_idx"
  ON "mod_fundae_group"("tenant_id", "company_id", "status");

CREATE INDEX "mod_fundae_group_tenant_action_status_idx"
  ON "mod_fundae_group"("tenant_id", "action_id", "status");

CREATE INDEX "mod_fundae_group_tenant_status_fecha_idx"
  ON "mod_fundae_group"("tenant_id", "status", "fecha_inicio_prevista" DESC);

-- mod.fundae.cost: desglose de costes con FK al grupo.
CREATE TABLE "mod_fundae_cost" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "group_id" UUID NOT NULL,
  "tipo" TEXT NOT NULL,
  "concepto" VARCHAR(200) NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "notas" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mod_fundae_cost_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "mod_fundae_cost"
  ADD CONSTRAINT "mod_fundae_cost_group_fk"
  FOREIGN KEY ("group_id") REFERENCES "mod_fundae_group"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "mod_fundae_cost_tenant_group_tipo_idx"
  ON "mod_fundae_cost"("tenant_id", "group_id", "tipo");

CREATE INDEX "mod_fundae_cost_group_idx"
  ON "mod_fundae_cost"("group_id");
