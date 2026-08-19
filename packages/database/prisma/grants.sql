-- ============================================================================
-- Didacta — roles y grants de runtime (RLS real, F3 — flip a didacta_app)
-- ----------------------------------------------------------------------------
-- Se aplica en cada arranque junto a rls.sql (idempotente), con el usuario
-- ADMIN_DATABASE_URL (bootstrap):
--   pnpm --filter @didacta/database db:grants:apply
--
-- Crea el rol de runtime `didacta_app`: NOSUPERUSER, NOBYPASSRLS y no-owner
-- de las tablas, de modo que las políticas RLS (ENABLE + FORCE) le aplican
-- SIEMPRE. Es el rol con el que conecta la app en runtime (DATABASE_URL).
--
-- `didacta_super` (BYPASSRLS, creado en rls.sql) es el escape auditado para
-- acceso global sancionado (runSanctionedGlobalAccess): auth por API key,
-- refresh token, resolución host→tenant, dispatcher del outbox, /setup/init,
-- sweeps de workers. didacta_app es MIEMBRO de didacta_super para poder hacer
-- `SET LOCAL ROLE didacta_super` dentro de una transacción (ver
-- rls-enforcement.extension.ts) — la membership NO hereda BYPASSRLS de forma
-- pasiva (es un atributo de rol, no un privilegio), así que las queries
-- normales de didacta_app siguen escopadas por RLS. Como `SET ROLE` cambia el
-- `current_user` para el chequeo de privilegios, didacta_super necesita SUS
-- PROPIOS grants de tabla (no basta con la membership).
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
-- ejecuta `ALTER ROLE didacta_app PASSWORD ...` con POSTGRES_APP_PASSWORD
-- (env o autogenerada y persistida en /app/data — ver infra/docker/entrypoint.sh).

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

-- ----------------------------------------------------------------------------
-- didacta_super: grants propios (BYPASSRLS ya lo da rls.sql) + membership de
-- didacta_app para poder `SET ROLE`. Sin LOGIN: nunca se conecta directo,
-- solo se alcanza vía SET LOCAL ROLE desde una sesión de didacta_app.
-- ----------------------------------------------------------------------------
GRANT didacta_super TO didacta_app;

GRANT USAGE ON SCHEMA public TO didacta_super;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO didacta_super;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO didacta_super;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO didacta_super;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO didacta_super;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO didacta_super;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO didacta_super;

-- CREATE en `public` para el escape auditado, NO para el rol de runtime.
--
-- Las migraciones de los módulos del marketplace (`.didactamod`) se aplican
-- desde la API, con la `DATABASE_URL` de runtime, que en el compose estándar
-- es `didacta_app` (NOSUPERUSER NOBYPASSRLS, solo USAGE + DML). Desde
-- Postgres 15 el esquema `public` ya NO concede CREATE a los no-owner, así
-- que cualquier módulo con un `CREATE TABLE` moría con "permission denied for
-- schema public" → MODULE_BOOT_FAILED → instalación FAILED, siempre, en el
-- despliegue por defecto. Los tests no lo veían porque corren como superuser
-- del cluster de test.
--
-- El permiso va a `didacta_super` y no a `didacta_app` para no ensanchar el
-- rol con el que corre todo el día la aplicación: el instalador hace
-- `SET LOCAL ROLE didacta_super` solo mientras aplica el SQL del módulo
-- (ver `apps/api/src/marketplace/module-migration.service.ts`).
GRANT CREATE ON SCHEMA public TO didacta_super;
