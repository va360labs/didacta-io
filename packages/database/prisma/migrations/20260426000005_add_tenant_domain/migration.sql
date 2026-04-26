-- =============================================================================
-- Tenant domains — mapeo Host header → tenant para login transparente.
-- Cada tenant puede tener múltiples dominios (subdominio default + customs).
-- =============================================================================

CREATE TABLE "tenant_domain" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "hostname" VARCHAR(253) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_domain_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_domain_tenant_id_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenant"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "tenant_domain_hostname_key" ON "tenant_domain"("hostname");
CREATE INDEX "tenant_domain_tenant_id_idx" ON "tenant_domain"("tenant_id");

-- Garantía: un solo isPrimary=true por tenant (índice parcial UNIQUE).
CREATE UNIQUE INDEX "tenant_domain_tenant_id_primary_unique"
    ON "tenant_domain"("tenant_id")
    WHERE "is_primary" = true;
