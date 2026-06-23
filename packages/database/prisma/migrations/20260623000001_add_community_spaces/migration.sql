-- Migration: 20260623000001_add_community_spaces
-- Espacios de comunidad administrables por el admin.
-- Los 4 espacios iniciales (general, anuncios, preguntas, recursos) se marcan
-- como is_system=true: editables pero no eliminables.

-- ── mod_community_space ────────────────────────────────────────────────────

CREATE TABLE "mod_community_space" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"     UUID         NOT NULL,
  "slug"          VARCHAR(80)  NOT NULL,
  "title"         TEXT         NOT NULL,
  "description"   TEXT,
  "icon"          TEXT         NOT NULL DEFAULT '#',
  "color"         TEXT         NOT NULL DEFAULT 'var(--didacta-trust)',
  "sort_order"    INTEGER      NOT NULL DEFAULT 0,
  "is_system"     BOOLEAN      NOT NULL DEFAULT false,
  "created_by_id" UUID,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mod_community_space_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_community_space_tenant_slug_key"
  ON "mod_community_space" ("tenant_id", "slug");

CREATE INDEX "mod_community_space_tenant_sort_idx"
  ON "mod_community_space" ("tenant_id", "sort_order");

-- ── Seed: 4 espacios de sistema para todos los tenants existentes ──────────

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
WHERE t.deleted_at IS NULL;
