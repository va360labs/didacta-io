-- mod.zoom-live: vincular una sesión a una lección concreta del curso
-- (no solo al curso). Permite mostrar el botón "Unirse" en el detalle
-- de la lección para el alumno.
ALTER TABLE "mod_zoom_session"
  ADD COLUMN "lesson_id" UUID;

CREATE INDEX "mod_zoom_session_lesson_idx" ON "mod_zoom_session"("lesson_id") WHERE "lesson_id" IS NOT NULL;
