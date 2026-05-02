-- MIG-030: Marketplace — registro de migraciones SQL del paquete aplicadas.
-- ADR-009 PR D: el `*.didactamod` puede traer un subdir `prisma/migrations/`
-- con SQL que el orquestador aplica a la BD de la instancia tras el upload.
-- Trackeamos qué migraciones aplicaron OK para no re-correrlas en upgrades.

ALTER TABLE "installed_module"
    ADD COLUMN "migrations_applied"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "migrations_applied_at" TIMESTAMP(3);
