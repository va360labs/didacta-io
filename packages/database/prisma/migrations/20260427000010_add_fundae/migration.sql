-- mod.fundae: acciones formativas para subvenciones Fundae España.
CREATE TABLE "mod_fundae_action" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "course_id" UUID,
  "codigo_accion" TEXT NOT NULL,
  "nombre" TEXT NOT NULL,
  "modalidad" TEXT NOT NULL,
  "horas_formacion" DOUBLE PRECISION NOT NULL,
  "fecha_inicio" TEXT NOT NULL,
  "fecha_fin" TEXT NOT NULL,
  "lugar" TEXT,
  "cif_centro" TEXT,
  "notas" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mod_fundae_action_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_fundae_action_codigo_per_tenant_idx" ON "mod_fundae_action"("tenant_id", "codigo_accion");
CREATE INDEX "mod_fundae_action_tenant_inicio_idx" ON "mod_fundae_action"("tenant_id", "fecha_inicio" DESC);
CREATE INDEX "mod_fundae_action_course_idx" ON "mod_fundae_action"("course_id") WHERE "course_id" IS NOT NULL;
