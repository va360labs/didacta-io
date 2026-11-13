-- mod.theming — la academia se presenta en su comunidad como un grupo de Skool:
-- descripción propia, enlaces sociales y portada.
--
-- Solo AÑADE columnas; no toca ninguna fila:
--   - `about` y `cover_*` nacen NULL: la tarjeta de /community sigue igual
--     (titular de acceso como descripción y banda de color como portada).
--   - `social_links` nace `[]` (sin enlaces). `ADD COLUMN ... NOT NULL DEFAULT`
--     con un default constante es solo de catálogo en Postgres >= 11: no
--     reescribe la tabla.
-- RLS: la política `tenant_isolation` de la tabla es por fila (`tenant_id`) y
-- cubre las columnas nuevas sin cambios; los GRANT son por tabla.

ALTER TABLE "mod_theming_tenant_theme"
  ADD COLUMN "about" VARCHAR(280),
  ADD COLUMN "social_links" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "cover_url" TEXT,
  ADD COLUMN "cover_storage_key" TEXT,
  ADD COLUMN "cover_mime_type" TEXT;
