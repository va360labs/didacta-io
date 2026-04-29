-- LMS-90.B: AI Gateway multi-provider — config por tenant.

CREATE TABLE "tenant_ai_provider_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "api_key_cipher" TEXT NOT NULL,
    "api_key_iv" TEXT NOT NULL,
    "api_key_tag" TEXT NOT NULL,
    "base_url" TEXT,
    "extra_headers" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notas" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_ai_provider_config_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_ai_provider_config_tenant_purpose_key"
    ON "tenant_ai_provider_config" ("tenant_id", "purpose");

CREATE INDEX "tenant_ai_provider_config_tenant_idx"
    ON "tenant_ai_provider_config" ("tenant_id");
