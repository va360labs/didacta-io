-- MIG-027: Installation Registry (opt-in)
-- Permite al admin Community registrar la instalación contra Cloud god
-- y consentir envío de telemetría agregada sin PII.

CREATE TABLE "core_installation_registry" (
    "id" UUID NOT NULL,
    "installation_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "organization_name" TEXT NOT NULL,
    "deployment_url" TEXT,
    "registry_token" TEXT,
    "terms_accepted_at" TIMESTAMP(3) NOT NULL,
    "opt_in_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opted_out_at" TIMESTAMP(3),
    "last_telemetry_at" TIMESTAMP(3),
    "telemetry_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_installation_registry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "core_installation_registry_installation_id_key"
    ON "core_installation_registry"("installation_id");

-- Esta tabla es del CORE (no tiene tenant_id) y vive como singleton lógico:
-- solo debe existir UNA fila no-opted-out a la vez. La unicidad de negocio
-- se garantiza en RegistryService.optIn() con UPSERT lógico, no con índice
-- (porque opted_out viejos pueden coexistir como histórico de auditoría).
