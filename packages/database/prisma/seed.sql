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
--
-- ── En el idioma del aula ───────────────────────────────────────────────────
-- Los espacios se crean en el idioma del aula (es/en/pt) con la MISMA regla que
-- `academyLocale()` (apps/api/src/common/academy-defaults.ts): el ajuste del
-- aula (`tenant_setting academy/locale`); si no lo tiene, la deducción de
-- respaldo: el idioma que eligió la creadora en el alta de 3 preguntas
-- (`tenant_setting simple-mode/state.locale`); si no lo hay, el del perfil de
-- la primera persona activa que administra el aula (`tenant_admin`, por
-- antigüedad); si tampoco, español. Antes se sembraban siempre en español y un
-- aula en inglés recibía «Recursos compartidos» en cada reinicio. Si cambias la
-- regla en un sitio, cámbiala en el otro: `seed-system-spaces.integration.test.ts`
-- compara los dos.
--
-- La lectura del idioma es de mejor esfuerzo, como en el código: si falla (un
-- cambio de esquema), avisa con un WARNING y sigue en español. Un arranque
-- nunca se cae por no saber el idioma.
--
-- ── Nunca se duplica ni se toca lo que ya existe ────────────────────────────
-- Solo se INSERTA: un espacio que ya existe no se renombra ni se traduce, esté
-- en el idioma que esté. Además de por slug, «Recursos compartidos» se salta si
-- el aula ya tiene un espacio con ese título en cualquiera de los tres idiomas
-- (es el que la gente crea a mano: el formulario lo propone como ejemplo). Los
-- otros tres solo se comparan por slug porque el código depende de él (el
-- espacio `general` es el destino por defecto de la API y del agente).

DO $$
DECLARE
  t record;
  idioma text;
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

    idioma := NULL;
    BEGIN
      -- 0) El ajuste del aula (Ajustes, alta sencilla o aprovisionamiento).
      SELECT CASE split_part(translate(lower(btrim(s.value_json #>> '{}')), '_', '-'), '-', 1)
               WHEN 'en' THEN 'en'
               WHEN 'es' THEN 'es'
               WHEN 'pt' THEN 'pt'
             END
        INTO idioma
        FROM "tenant_setting" s
       WHERE s.tenant_id = t.id
         AND s.module_name = 'academy'
         AND s.key = 'locale'
         AND jsonb_typeof(s.value_json) = 'string';

      -- 1) Sin ajuste: el idioma elegido en el alta sencilla.
      IF idioma IS NULL THEN
        SELECT CASE split_part(translate(lower(btrim(s.value_json ->> 'locale')), '_', '-'), '-', 1)
                 WHEN 'en' THEN 'en'
                 WHEN 'es' THEN 'es'
                 WHEN 'pt' THEN 'pt'
               END
          INTO idioma
          FROM "tenant_setting" s
         WHERE s.tenant_id = t.id
           AND s.module_name = 'simple-mode'
           AND s.key = 'state'
           AND jsonb_typeof(s.value_json -> 'locale') = 'string';
      END IF;

      -- 2) El perfil de la primera persona que administra el aula (de las 5
      --    más antiguas, la primera con un idioma que el aula conoce).
      IF idioma IS NULL THEN
        SELECT a.l
          INTO idioma
          FROM (
            SELECT CASE split_part(translate(lower(btrim(u.locale)), '_', '-'), '-', 1)
                     WHEN 'en' THEN 'en'
                     WHEN 'es' THEN 'es'
                     WHEN 'pt' THEN 'pt'
                   END AS l,
                   u.created_at
              FROM "user" u
             WHERE u.tenant_id = t.id
               AND u.deleted_at IS NULL
               AND u.status = 'ACTIVE'
               AND EXISTS (
                 SELECT 1
                   FROM "user_role" ur
                   JOIN "role" r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id
                    AND r.name = 'tenant_admin'
               )
             ORDER BY u.created_at ASC
             LIMIT 5
          ) a
         WHERE a.l IS NOT NULL
         ORDER BY a.created_at ASC
         LIMIT 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'seed.sql: no se pudo leer el idioma del aula % (%); se siembra en español', t.id, SQLERRM;
      idioma := NULL;
    END;
    idioma := COALESCE(idioma, 'es');

    INSERT INTO "mod_community_space"
      ("id", "tenant_id", "slug", "title", "description", "icon", "color", "sort_order", "is_system", "updated_at")
    SELECT
      gen_random_uuid(),
      t.id,
      s.slug,
      CASE idioma WHEN 'en' THEN s.title_en WHEN 'pt' THEN s.title_pt ELSE s.title_es END,
      CASE idioma WHEN 'en' THEN s.description_en WHEN 'pt' THEN s.description_pt ELSE s.description_es END,
      s.icon,
      s.color,
      s.sort_order,
      true,
      CURRENT_TIMESTAMP
    FROM (VALUES
      ('general',
         'General',              'Conversaciones abiertas para toda la comunidad.',
         'General',              'Open conversations for the whole community.',
         'Geral',                'Conversas abertas para toda a comunidade.',
         '#',  'var(--didacta-trust)',   1, false),
      ('anuncios',
         'Anuncios',             'Comunicaciones oficiales del equipo de formación.',
         'Announcements',        'Official updates from the teaching team.',
         'Avisos',               'Comunicados oficiais da equipe de ensino.',
         '📣', 'var(--didacta-coral)',   2, false),
      ('preguntas',
         'Preguntas y dudas',    'Resuelve tus dudas con la ayuda de la comunidad.',
         'Questions',            'Get answers to your questions with help from the community.',
         'Perguntas e dúvidas',  'Tire suas dúvidas com a ajuda da comunidade.',
         '❓', 'var(--didacta-growth)',  3, false),
      ('recursos',
         'Recursos compartidos', 'Plantillas, apuntes y materiales de apoyo.',
         'Shared resources',     'Templates, notes and supporting materials.',
         'Materiais compartilhados', 'Modelos, anotações e materiais de apoio.',
         '📁', 'var(--didacta-balance)', 4, true)
    ) AS s(slug, title_es, description_es, title_en, description_en, title_pt, description_pt,
           icon, color, sort_order, por_titulo)
    WHERE NOT (
      s.por_titulo AND EXISTS (
        SELECT 1 FROM "mod_community_space" e
         WHERE e.tenant_id = t.id
           AND lower(btrim(e.title)) IN (lower(s.title_es), lower(s.title_en), lower(s.title_pt))
      )
    )
    ON CONFLICT ("tenant_id", "slug") DO NOTHING;
  END LOOP;

  PERFORM set_config('app.current_tenant_id', COALESCE(previo, ''), true);
END $$;
