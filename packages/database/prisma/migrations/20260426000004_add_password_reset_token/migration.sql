-- =============================================================================
-- Password reset tokens — soporte para flujo "olvidé mi contraseña".
-- El token raw viaja solo en email; la DB persiste SHA-256 hex (no recuperable
-- aunque se filtre el dump). TTL 1h; single-use.
-- =============================================================================

CREATE TABLE "password_reset_token" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "request_ip" TEXT,
    "request_ua" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_token_token_hash_key"
    ON "password_reset_token"("token_hash");

CREATE INDEX "password_reset_token_tenant_id_user_id_idx"
    ON "password_reset_token"("tenant_id", "user_id");

CREATE INDEX "password_reset_token_expires_at_idx"
    ON "password_reset_token"("expires_at");
