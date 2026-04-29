-- LMS-84: Cálculo de finalización Fundae con umbral 75% parametrizable.
--
-- Añade al grupo el umbral configurable y a cada participante los campos
-- snapshot del cálculo: horas asistidas, progreso, resultado APTO/NO_APTO/EN_CURSO,
-- fecha de cálculo. Todo aditivo, no rompe filas existentes.

-- ─── Grupo ──────────────────────────────────────────────────────────────────

ALTER TABLE "mod_fundae_group"
    ADD COLUMN "umbral_finalizacion_pct" INTEGER NOT NULL DEFAULT 75;

-- ─── Participante ───────────────────────────────────────────────────────────

ALTER TABLE "mod_fundae_group_participant"
    ADD COLUMN "horas_asistidas" DECIMAL(8, 2),
    ADD COLUMN "progress_percent" INTEGER,
    ADD COLUMN "resultado" TEXT,
    ADD COLUMN "completed_at" TIMESTAMP(3);

-- Índice para reportes "alumnos APTO por grupo" usado por la UI Fundae.
CREATE INDEX "mod_fundae_group_participant_resultado_idx"
    ON "mod_fundae_group_participant" ("tenant_id", "group_id", "resultado");
