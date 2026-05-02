-- MIG-029: Marketplace — registro de módulos instalados a nivel instancia (ADR-009).
--
-- Crea `installed_module` con el catálogo de paquetes *.didactamod que la
-- instancia ha aceptado. Sin tenantId: la instalación es global; la
-- activación por tenant sigue en `tenant_module`.
--
-- Esta migración es solo el registry. NO bootea el módulo en runtime ni
-- aplica las migraciones del paquete subido (eso es PR B/C de ADR-009).

-- 1. Enums.
CREATE TYPE "InstalledModuleVendor" AS ENUM ('VA360', 'COMMUNITY');

CREATE TYPE "InstalledModuleStatus" AS ENUM (
    'INSTALLING',
    'INSTALLED',
    'FAILED',
    'DEPRECATED'
);

-- 2. Tabla installed_module.
CREATE TABLE "installed_module" (
    "id"                     UUID NOT NULL,
    "name"                   TEXT NOT NULL,
    "version"                TEXT NOT NULL,
    "prev_version"           TEXT,
    "vendor"                 "InstalledModuleVendor" NOT NULL,
    "display_name"           TEXT NOT NULL,
    "description"            TEXT,
    "manifest_json"          JSONB NOT NULL,
    "signature_b64"          TEXT NOT NULL,
    "signed_at"              TIMESTAMP(3) NOT NULL,
    "package_storage_key"    TEXT NOT NULL,
    "package_sha256"         TEXT NOT NULL,
    "package_size_bytes"     INTEGER NOT NULL,
    "core_version_required"  TEXT NOT NULL,
    "table_prefix"           TEXT NOT NULL,
    "api_namespace"          TEXT NOT NULL,
    "required_capabilities"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "required_env_vars"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isolation"              TEXT NOT NULL DEFAULT 'vm',
    "status"                 "InstalledModuleStatus" NOT NULL DEFAULT 'INSTALLING',
    "error_message"          TEXT,
    "installed_by_id"        UUID NOT NULL,
    "installed_at"           TIMESTAMP(3),
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "installed_module_pkey" PRIMARY KEY ("id")
);

-- 3. Constraints.
-- Slug único: una instancia tiene una sola versión activa de cada módulo.
-- Reinstall/upgrade actualiza el row in-place, no inserta uno nuevo.
CREATE UNIQUE INDEX "installed_module_name_key" ON "installed_module" ("name");

-- 4. Índices de query.
-- Listado por estado (typical: dashboard del super_admin filtrando INSTALLED).
CREATE INDEX "installed_module_status_idx" ON "installed_module" ("status");
-- Filtro por vendor (informes / restricción "solo VA360" en MVP).
CREATE INDEX "installed_module_vendor_idx" ON "installed_module" ("vendor");
