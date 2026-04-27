-- mod.zoom-live: registro de eventos de webhook recibidos para idempotencia.
-- Zoom puede reintentar el mismo evento varias veces (al menos 3 si no responde
-- 2xx en 3s). Guardamos el event_id (UUID que Zoom genera por evento) y nos
-- saltamos los duplicados.
CREATE TABLE "mod_zoom_webhook_event" (
  "id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "meeting_id" TEXT,
  "session_id" UUID,
  "tenant_id" UUID,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "result" TEXT NOT NULL DEFAULT 'OK', -- OK | IGNORED | ERROR
  "error_message" TEXT,
  CONSTRAINT "mod_zoom_webhook_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_zoom_webhook_event_event_id_key" ON "mod_zoom_webhook_event"("event_id");
CREATE INDEX "mod_zoom_webhook_event_meeting_idx" ON "mod_zoom_webhook_event"("meeting_id");
CREATE INDEX "mod_zoom_webhook_event_session_idx" ON "mod_zoom_webhook_event"("session_id") WHERE "session_id" IS NOT NULL;
