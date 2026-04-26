-- CreateTable
CREATE TABLE "tenant_setting" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "module_name" VARCHAR(100) NOT NULL,
  "key" VARCHAR(200) NOT NULL,
  "is_secret" BOOLEAN NOT NULL DEFAULT false,
  "value_json" JSONB,
  "value_cipher" BYTEA,
  "value_iv" BYTEA,
  "value_tag" BYTEA,
  "updated_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tenant_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_setting_tenant_id_module_name_key_key" ON "tenant_setting"("tenant_id", "module_name", "key");

-- CreateIndex
CREATE INDEX "tenant_setting_tenant_id_module_name_idx" ON "tenant_setting"("tenant_id", "module_name");

-- AddForeignKey
ALTER TABLE "tenant_setting"
  ADD CONSTRAINT "tenant_setting_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
