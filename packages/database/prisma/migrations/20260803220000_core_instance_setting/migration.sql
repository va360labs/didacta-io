-- CreateTable
CREATE TABLE "core_instance_setting" (
    "id" UUID NOT NULL,
    "scope" VARCHAR(100) NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "value_json" JSONB,
    "value_cipher" BYTEA,
    "value_iv" BYTEA,
    "value_tag" BYTEA,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_instance_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "core_instance_setting_scope_key_key" ON "core_instance_setting"("scope", "key");
