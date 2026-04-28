-- mod.fundae: módulos formativos por acción.
-- Cada acción Fundae se desglosa en N bloques con horas, contenidos y
-- modalidad propia (puede diferir de la modalidad global de la acción
-- en mixtas: 4h presenciales + 6h teleformación).
CREATE TABLE "mod_fundae_block" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "action_id" UUID NOT NULL,
  -- Orden secuencial dentro de la acción (1, 2, 3...). UNIQUE(action, ordinal).
  "ordinal" INTEGER NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  -- Horas del bloque. Acepta decimales (0.5 = media hora). Debe sumar
  -- como mucho horasFormacion de la acción; lo valida el service al
  -- crear/editar.
  "hours" DOUBLE PRECISION NOT NULL,
  -- PRESENCIAL | TELEFORMACION | MIXTA. Puede diferir de la modalidad
  -- de la acción (ej. acción MIXTA con bloques individuales de cada tipo).
  "modalidad" TEXT NOT NULL,
  -- Contenidos del bloque (texto libre multilínea).
  "contenidos" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mod_fundae_block_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_fundae_block_action_ordinal_key" ON "mod_fundae_block"("action_id", "ordinal");
CREATE INDEX "mod_fundae_block_tenant_action_idx" ON "mod_fundae_block"("tenant_id", "action_id");
