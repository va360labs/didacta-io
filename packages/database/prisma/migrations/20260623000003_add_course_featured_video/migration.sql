-- Vídeo destacado del hero del curso (mostrado al alumno no inscrito).
-- La imagen destacada reutiliza la columna existente thumbnail_url.
ALTER TABLE "mod_courses_course" ADD COLUMN "featured_video_url" TEXT;
