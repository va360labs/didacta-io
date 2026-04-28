-- mod.zoom-live: persistir URL y duración de grabación cuando llega el
-- webhook `recording.completed` de Zoom. La URL es `share_url` (la que se
-- comparte con la audiencia) y la duración viene en segundos en el payload
-- `recording_files[].recording_end - recording_start`. Para v0.3 guardamos
-- el total de minutos del meeting (`payload.object.duration` en minutos).
ALTER TABLE "mod_zoom_session"
  ADD COLUMN "recording_url" TEXT,
  ADD COLUMN "recording_duration_minutes" INTEGER;
