-- Backfill del autor de los comentarios de lección.
--
-- `author_display_name` es un snapshot que se escribe al crear el comentario,
-- pero el handler lo guardaba siempre a NULL (pasaba `displayName: null`
-- hardcodeado). Resultado: TODOS los comentarios existentes se muestran como
-- "Anónimo" en la cola de moderación del formador y en la lección.
--
-- El fix del controller sólo arregla los nuevos, así que aquí recuperamos el
-- nombre de los ya guardados desde el User (name → email, igual que el
-- fallback de `authorOf`). Sin cambios de esquema: sólo datos.
--
-- El join lleva `tenant_id` además de `author_id` para no cruzar tenants aun
-- en el caso improbable de un id repetido entre ellos.
--
-- ⚠️ EJECUTAR A MANO. El entrypoint despliega con `prisma db push`, que NO
-- aplica esta carpeta: db push sincroniza el *esquema* y esto es sólo datos.
-- Aplicar una vez por entorno con:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f packages/database/prisma/migrations/20260728000002_backfill_lesson_comment_author_name/migration.sql
-- Es idempotente (el WHERE ... IS NULL lo hace reentrante), así que repetirlo
-- no tiene efecto ni pisa nombres ya resueltos.

UPDATE "mod_learning_lesson_comment" AS c
SET "author_display_name" = COALESCE(u."name", u."email")
FROM "user" AS u
WHERE u."id" = c."author_id"
  AND u."tenant_id" = c."tenant_id"
  AND c."author_display_name" IS NULL;
