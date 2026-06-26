-- Identidad federada (WordPress SSO y, a futuro, OIDC/SAML). Clave de identidad
-- estable = (tenant_id, provider, issuer, external_id=sub), independiente del email.
-- La RLS por tenant_id se aplica automáticamente vía prisma/rls.sql (bloque genérico
-- que cubre toda tabla con columna tenant_id): ejecutar `db:rls:apply` tras migrar.

-- CreateTable
CREATE TABLE "user_external_identity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "issuer" VARCHAR(255) NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "email_at_link" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "link_method" VARCHAR(30) NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_external_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_ext_identity_subject_key" ON "user_external_identity"("tenant_id", "provider", "issuer", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_ext_identity_one_per_provider_key" ON "user_external_identity"("tenant_id", "user_id", "provider", "issuer");

-- CreateIndex
CREATE INDEX "user_external_identity_tenant_id_provider_external_id_idx" ON "user_external_identity"("tenant_id", "provider", "external_id");

-- AddForeignKey
ALTER TABLE "user_external_identity" ADD CONSTRAINT "user_external_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
