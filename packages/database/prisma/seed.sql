-- Seed idempotente — se aplica en cada arranque del contenedor tras prisma db push.
-- Inserta los espacios de sistema para todos los tenants que todavía no los tengan.
-- ON CONFLICT (tenant_id, slug) DO NOTHING garantiza que es reentrante.
--
-- ── Por qué siembra tenant a tenant y no con un solo INSERT masivo ──────────
-- `rls.sql` marca las tablas con `FORCE ROW LEVEL SECURITY`: la política
-- `tenant_isolation` aplica TAMBIÉN al owner de la tabla. En el compose por
-- defecto eso no se nota porque el usuario admin es el superuser del
-- contenedor, y los superusers ignoran RLS. Pero en un Postgres GESTIONADO
-- (RDS, Cloud SQL, Supabase) o en uno compartido, el usuario que aplica este
-- fichero es owner y NO superuser: con el INSERT masivo, el `WITH CHECK
-- (tenant_id = current_tenant_id())` se evaluaba contra un
-- `app.current_tenant_id` vacío y el seed reventaba en cada reinicio posterior
-- al primer tenant.
--
-- Escalar a `didacta_super` no sirve como solución general: crear un rol con
-- BYPASSRLS exige superuser de verdad, así que en un gestionado ese rol no
-- llega a existir. Lo que sí funciona en todas partes es respetar la política
-- en vez de esquivarla: se fija `app.current_tenant_id` para cada tenant y se
-- inserta dentro de su propio contexto. Sirve igual para superuser, para owner
-- y para cualquier rol con permisos de escritura.
--
-- `set_config(..., true)` es local a la transacción, así que el ajuste muere
-- con el bloque y no contamina la sesión de psql.

DO $$
DECLARE
  t record;
  previo text := current_setting('app.current_tenant_id', true);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mod_community_space'
  ) THEN
    RETURN;
  END IF;

  FOR t IN SELECT id FROM "tenant" WHERE deleted_at IS NULL LOOP
    PERFORM set_config('app.current_tenant_id', t.id::text, true);

    INSERT INTO "mod_community_space"
      ("id", "tenant_id", "slug", "title", "description", "icon", "color", "sort_order", "is_system", "updated_at")
    SELECT
      gen_random_uuid(),
      t.id,
      s.slug,
      s.title,
      s.description,
      s.icon,
      s.color,
      s.sort_order,
      true,
      CURRENT_TIMESTAMP
    FROM (VALUES
      ('general',   'General',              'Conversaciones abiertas para toda la comunidad.',   '#',  'var(--didacta-trust)',   1),
      ('anuncios',  'Anuncios',             'Comunicaciones oficiales del equipo de formación.', '📣', 'var(--didacta-coral)',   2),
      ('preguntas', 'Preguntas y dudas',    'Resuelve tus dudas con la ayuda de la comunidad.',  '❓', 'var(--didacta-growth)',  3),
      ('recursos',  'Recursos compartidos', 'Plantillas, apuntes y materiales de apoyo.',        '📁', 'var(--didacta-balance)', 4)
    ) AS s(slug, title, description, icon, color, sort_order)
    ON CONFLICT ("tenant_id", "slug") DO NOTHING;
  END LOOP;

  PERFORM set_config('app.current_tenant_id', COALESCE(previo, ''), true);
END $$;
