-- CreateTable
CREATE TABLE "mod_payment_connections_tier" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_free" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payment_connections_tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payment_connections_user_tier" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "manual_tier_id" UUID,
    "derived_label" TEXT,
    "derived_provider" TEXT,
    "derived_connection_id" UUID,
    "derived_ref" TEXT,
    "derived_synced_at" TIMESTAMP(3),
    "assigned_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payment_connections_user_tier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_conn_tier_tenant_name_key" ON "mod_payment_connections_tier"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "mod_payment_connections_tier_tenant_id_idx" ON "mod_payment_connections_tier"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_conn_user_tier_tenant_user_key" ON "mod_payment_connections_user_tier"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_payment_connections_user_tier_tenant_id_idx" ON "mod_payment_connections_user_tier"("tenant_id");

-- CreateIndex
CREATE INDEX "mod_payment_connections_user_tier_manual_tier_id_idx" ON "mod_payment_connections_user_tier"("manual_tier_id");

-- AddForeignKey
ALTER TABLE "mod_payment_connections_user_tier" ADD CONSTRAINT "fk_pc_user_tier_manual" FOREIGN KEY ("manual_tier_id") REFERENCES "mod_payment_connections_tier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
