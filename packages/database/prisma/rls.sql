-- ============================================================================
-- LearnShip — Row-Level Security + triggers de append-only
-- ----------------------------------------------------------------------------
-- Se aplica después de cada migración Prisma:
--   pnpm --filter @learnship/database db:rls:apply
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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'learnship_super') THEN
    CREATE ROLE learnship_super BYPASSRLS;
  END IF;
END $$;
