-- Seed idempotente — se aplica en cada arranque del contenedor tras prisma db push.
-- Inserta los espacios de sistema para todos los tenants que todavía no los tengan.
-- ON CONFLICT (tenant_id, slug) DO NOTHING garantiza que es reentrante.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mod_community_space'
  ) THEN
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
    FROM "tenant" t
    CROSS JOIN (VALUES
      ('general',   'General',              'Conversaciones abiertas para toda la comunidad.',   '#',  'var(--didacta-trust)',   1),
      ('anuncios',  'Anuncios',             'Comunicaciones oficiales del equipo de formación.', '📣', 'var(--didacta-coral)',   2),
      ('preguntas', 'Preguntas y dudas',    'Resuelve tus dudas con la ayuda de la comunidad.',  '❓', 'var(--didacta-growth)',  3),
      ('recursos',  'Recursos compartidos', 'Plantillas, apuntes y materiales de apoyo.',        '📁', 'var(--didacta-balance)', 4)
    ) AS s(slug, title, description, icon, color, sort_order)
    WHERE t.deleted_at IS NULL
    ON CONFLICT ("tenant_id", "slug") DO NOTHING;
  END IF;
END $$;
