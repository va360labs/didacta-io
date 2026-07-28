-- ADR-018 — Asistencia real a clases en directo (frente a la inscripción,
-- que solo registra intención). Dos fuentes en la misma fila: el click en
-- "Unirme" desde Didacta (`clicked_join_at`) y lo que reporta Zoom al
-- reconciliar la sesión terminada (`present`, `minutes`, `joined_at`…).
-- tenant_id NOT NULL a propósito: la política RLS genérica (rls.sql) cubre
-- automáticamente toda tabla de public con columna tenant_id.

ALTER TABLE "mod_zoom_session" ADD COLUMN IF NOT EXISTS "zoom_meeting_uuid" TEXT;
ALTER TABLE "mod_zoom_session" ADD COLUMN IF NOT EXISTS "attendance_synced_at" TIMESTAMP(3);
ALTER TABLE "mod_zoom_session" ADD COLUMN IF NOT EXISTS "attendance_sync_error" TEXT;

CREATE TABLE "mod_zoom_session_attendance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    -- NULL = participante de Zoom que no casa con ningún miembro del tenant.
    "user_id" UUID,
    "zoom_email" TEXT,
    "zoom_name" TEXT,
    "zoom_participant_id" TEXT,
    "clicked_join_at" TIMESTAMP(3),
    "present" BOOLEAN NOT NULL DEFAULT false,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMP(3),
    "left_at" TIMESTAMP(3),
    "manual_present" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_zoom_session_attendance_pkey" PRIMARY KEY ("id")
);

-- Los NULL son distintos entre sí en PostgreSQL: esto acota a una fila por
-- miembro identificado y deja convivir N participantes sin casar.
CREATE UNIQUE INDEX "mod_zoom_session_attendance_unique" ON "mod_zoom_session_attendance"("session_id", "user_id");

CREATE INDEX "mod_zoom_session_attendance_tenant_session_idx" ON "mod_zoom_session_attendance"("tenant_id", "session_id");

CREATE INDEX "mod_zoom_session_attendance_tenant_user_idx" ON "mod_zoom_session_attendance"("tenant_id", "user_id");

ALTER TABLE "mod_zoom_session_attendance"
    ADD CONSTRAINT "mod_zoom_session_attendance_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "mod_zoom_session"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
