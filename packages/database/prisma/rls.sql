-- ============================================================================
-- Didacta — Row-Level Security + triggers de append-only
-- ----------------------------------------------------------------------------
-- Se aplica después de cada migración Prisma:
--   pnpm --filter @didacta/database db:rls:apply
--
-- Cada transacción debe setear `app.current_tenant_id` vía middleware:
--   SET LOCAL app.current_tenant_id = '<uuid del tenant>';
-- El middleware del backend lo ejecuta en cada request tras resolver el tenant.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper: obtener el tenant actual (null si no está seteado)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
DECLARE
  v_id text;
BEGIN
  v_id := current_setting('app.current_tenant_id', true);
  IF v_id IS NULL OR v_id = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_id::uuid;
END;
$$ LANGUAGE plpgsql STABLE;

-- ----------------------------------------------------------------------------
-- Política genérica por tenant_id
-- Aplica a todas las tablas con columna tenant_id
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t2
      ON t2.table_schema = c.table_schema AND t2.table_name = c.table_name
    WHERE c.column_name = 'tenant_id'
      AND c.table_schema = 'public'
      AND t2.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.table_schema, t.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.table_schema, t.table_name);

    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON %I.%I',
      t.table_schema, t.table_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())',
      t.table_schema, t.table_name
    );
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Audit log: append-only (bloquear UPDATE y DELETE)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es append-only: no se permiten UPDATE ni DELETE (intento: %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_block_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_block_mutation();

-- ----------------------------------------------------------------------------
-- Rol de aplicación: exento de RLS solo para super_admin (migraciones, jobs globales)
-- ----------------------------------------------------------------------------
-- Los workers/superadmin usan este rol cuando necesitan saltarse RLS (seeders, cron jobs).
-- Jamás debe usarse en request path de usuarios finales.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'didacta_super') THEN
    CREATE ROLE didacta_super BYPASSRLS;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Índices únicos parciales (Prisma no expresa @@unique con WHERE)
-- Se aplican aquí porque Prisma no los expresa; el deploy los aplica con psql
-- justo después de `prisma migrate deploy` (el `db push` que decía este
-- comentario dejó de ser el camino hace versiones — ver infra/docker/entrypoint.sh).
-- Idempotentes (IF NOT EXISTS).
-- ----------------------------------------------------------------------------
-- Inscripción de miembros: telegram_id único por tenant cuando está presente.
-- Permite múltiples NULL (usuarios no creados por el flujo de Telegram).
-- DEPRECADO (D13): columnas de user en transición a mod_member_registration_profile;
-- este índice se retira en D13 F4 junto con las columnas.
CREATE UNIQUE INDEX IF NOT EXISTS user_tenant_telegram_id_key
  ON "user" ("tenant_id", "telegram_id")
  WHERE telegram_id IS NOT NULL;

-- Perfil de registro (mod.member-registration): mismo invariante sobre la
-- tabla nueva — telegram_id único por tenant cuando está presente.
CREATE UNIQUE INDEX IF NOT EXISTS mod_member_registration_profile_tenant_tg_key
  ON "mod_member_registration_profile" ("tenant_id", "telegram_id")
  WHERE telegram_id IS NOT NULL;
