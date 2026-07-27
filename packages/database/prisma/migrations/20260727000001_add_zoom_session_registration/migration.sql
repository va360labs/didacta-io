-- ADR-017 — Clases en directo: inscripciones por sesión sobre mod.zoom-live.
-- tenant_id NOT NULL a propósito: la política RLS genérica (rls.sql) cubre
-- automáticamente toda tabla de public con columna tenant_id.
CREATE TABLE "mod_zoom_session_registration" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_zoom_session_registration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_zoom_session_registration_unique" ON "mod_zoom_session_registration"("session_id", "user_id");

CREATE INDEX "mod_zoom_session_registration_tenant_user_idx" ON "mod_zoom_session_registration"("tenant_id", "user_id");

ALTER TABLE "mod_zoom_session_registration"
    ADD CONSTRAINT "mod_zoom_session_registration_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "mod_zoom_session"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
