-- ============================================================================
-- Didacta — roles y grants de runtime (RLS real, fase 0)
-- ----------------------------------------------------------------------------
-- Se aplica en cada arranque junto a rls.sql (idempotente):
--   pnpm --filter @didacta/database db:grants:apply
--
-- Crea el rol de runtime `didacta_app`: NOSUPERUSER, NOBYPASSRLS y no-owner
-- de las tablas, de modo que las políticas RLS (ENABLE + FORCE) le aplican
-- SIEMPRE. En esta fase la app aún conecta con el usuario bootstrap; el
-- cambio de DATABASE_URL a didacta_app llega en la fase de flip.
--
-- Los roles son objetos de CLUSTER (no de una base concreta): por eso viven
-- aquí y no en una migración Prisma — una migración se re-ejecuta contra la
-- shadow database de `migrate dev` y choca en Postgres gestionados.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'didacta_app') THEN
    CREATE ROLE didacta_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Sin contraseña el login queda inutilizable en la práctica: el entrypoint
-- ejecuta `ALTER ROLE didacta_app PASSWORD ...` solo si el operador define
-- POSTGRES_APP_PASSWORD (ver infra/docker/entrypoint.sh).

GRANT USAGE ON SCHEMA public TO didacta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO didacta_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO didacta_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO didacta_app;

-- Objetos que creen las migraciones futuras (las aplica el usuario bootstrap,
-- que es quien ejecuta este script — ALTER DEFAULT PRIVILEGES aplica a los
-- objetos que cree el rol ejecutor):
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO didacta_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO didacta_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO didacta_app;
