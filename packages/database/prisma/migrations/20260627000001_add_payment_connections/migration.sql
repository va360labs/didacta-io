-- CreateEnum
CREATE TYPE "PaymentConnectionStatus" AS ENUM ('PENDING', 'VERIFIED', 'ERROR', 'DISCONNECTED');

-- CreateTable
CREATE TABLE "mod_payment_connections_connection" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "PaymentConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "public_metadata" JSONB,
    "last_verified_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payment_connections_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payment_connections_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "result_status" TEXT NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_payment_connections_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_conn_tenant_provider_name_key" ON "mod_payment_connections_connection"("tenant_id", "provider", "display_name");

-- CreateIndex
CREATE INDEX "mod_payment_connections_connection_tenant_id_provider_idx" ON "mod_payment_connections_connection"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "mod_payment_connections_connection_tenant_id_status_idx" ON "mod_payment_connections_connection"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_payment_connections_log_tenant_id_connection_id_idx" ON "mod_payment_connections_log"("tenant_id", "connection_id");
