-- mod.payouts — cobros de plataforma (cimientos, etapa E1).
--
-- Solo AÑADE: siete enumerados y nueve tablas `mod_payouts_*` con sus índices.
-- No altera ninguna tabla existente ni escribe una sola fila. Una instalación
-- que actualice se queda exactamente como estaba, con las tablas vacías, hasta
-- que su operador defina `PAYMENTS_PLATFORM_STRIPE_SECRET_KEY` (solo Didacta
-- Cloud). Los `ALTER TABLE … ADD CONSTRAINT` del final son las claves foráneas
-- ENTRE las tablas nuevas (así las emite Prisma); ninguna apunta fuera del
-- módulo.
--
-- Las nueve llevan `tenant_id`, así que `rls.sql` les aplica sola la política
-- de aislamiento por tenant al reaplicarse tras la migración. El trigger que
-- hace de `mod_payouts_ledger_entry` un libro de solo inserción también vive
-- en `rls.sql`, junto al de `audit_log`.

-- CreateEnum
CREATE TYPE "PayoutsAccountStatus" AS ENUM ('NOT_CONNECTED', 'ONBOARDING', 'PENDING_REVIEW', 'READY', 'RESTRICTED', 'REJECTED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "PayoutsSaleStatus" AS ENUM ('AWAITING_FEE', 'READY', 'TRANSFERRED', 'SETTLED_NETTED', 'HELD', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutsSaleSourceKind" AS ENUM ('ORDER', 'SUBSCRIPTION_INVOICE');

-- CreateEnum
CREATE TYPE "PayoutsLedgerEntryType" AS ENUM ('SALE_GROSS', 'STRIPE_FEE', 'PLATFORM_FEE', 'TRANSFER', 'REFUND', 'PLATFORM_FEE_REFUND', 'TRANSFER_REVERSAL', 'DISPUTE_WITHDRAWN', 'DISPUTE_FEE', 'DISPUTE_REINSTATED', 'DEBT_CREATED', 'DEBT_RECOVERED', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PayoutsDebtReason" AS ENUM ('REFUND_FEE', 'DISPUTE', 'DISPUTE_FEE', 'REVERSAL_FAILED', 'MANUAL');

-- CreateEnum
CREATE TYPE "PayoutsDebtStatus" AS ENUM ('OPEN', 'RECOVERED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "PayoutsRefundReversalStatus" AS ENUM ('DONE', 'PARTIAL', 'FAILED_TO_DEBT');

-- CreateTable
CREATE TABLE "mod_payouts_settings" (
    "tenant_id" UUID NOT NULL,
    "fee_bps" INTEGER NOT NULL DEFAULT 500,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payouts_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "mod_payouts_account" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stripe_account_id" TEXT,
    "country" VARCHAR(2) NOT NULL,
    "entity_type" TEXT NOT NULL,
    "status" "PayoutsAccountStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "card_payments_status" TEXT,
    "transfers_status" TEXT,
    "payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
    "requirements_currently_due" JSONB NOT NULL DEFAULT '[]',
    "requirements_past_due" JSONB NOT NULL DEFAULT '[]',
    "requirements_deadline" TIMESTAMP(3),
    "disabled_reason" TEXT,
    "default_currency" VARCHAR(3),
    "fees_collector" TEXT,
    "losses_collector" TEXT,
    "payout_schedule" JSONB,
    "portal_configuration_id" TEXT,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "ready_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payouts_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payouts_object_ref" (
    "stripe_object_id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "local_ref" TEXT,
    "parent_object_id" TEXT,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_payouts_object_ref_pkey" PRIMARY KEY ("stripe_object_id")
);

-- CreateTable
CREATE TABLE "mod_payouts_sale" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "source_kind" "PayoutsSaleSourceKind" NOT NULL,
    "source_ref" TEXT NOT NULL,
    "description" TEXT,
    "buyer_email" TEXT,
    "stripe_charge_id" TEXT NOT NULL,
    "stripe_payment_intent_id" TEXT,
    "stripe_invoice_id" TEXT,
    "stripe_balance_transaction_id" TEXT,
    "presentment_amount" INTEGER NOT NULL,
    "presentment_currency" VARCHAR(3) NOT NULL,
    "gross" INTEGER,
    "stripe_fee" INTEGER,
    "fee_bps_applied" INTEGER,
    "platform_fee" INTEGER,
    "creator_net" INTEGER,
    "debt_netted" INTEGER NOT NULL DEFAULT 0,
    "transfer_amount" INTEGER,
    "currency" VARCHAR(3),
    "stripe_transfer_id" TEXT,
    "status" "PayoutsSaleStatus" NOT NULL DEFAULT 'AWAITING_FEE',
    "refunded_amount" INTEGER NOT NULL DEFAULT 0,
    "reversed_amount" INTEGER NOT NULL DEFAULT 0,
    "available_on" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "charged_at" TIMESTAMP(3),
    "transferred_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payouts_sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payouts_ledger_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "sale_id" UUID,
    "type" "PayoutsLedgerEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "stripe_object_id" TEXT,
    "stripe_balance_transaction_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_payouts_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payouts_debt" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "reason" "PayoutsDebtReason" NOT NULL,
    "origin_sale_id" UUID,
    "amount_original" INTEGER NOT NULL,
    "amount_outstanding" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "PayoutsDebtStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payouts_debt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payouts_refund" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "stripe_refund_id" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reversal_target" INTEGER,
    "stripe_reversal_id" TEXT,
    "reversal_status" "PayoutsRefundReversalStatus",
    "initiated_by" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payouts_refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payouts_dispute" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "stripe_dispute_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "fee" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "evidence_due_by" TIMESTAMP(3),
    "stripe_reversal_id" TEXT,
    "outcome" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payouts_dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payouts_webhook_event" (
    "stripe_event_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "type" TEXT NOT NULL,
    "object_id" TEXT,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "mod_payouts_webhook_event_pkey" PRIMARY KEY ("stripe_event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_account_stripe_account_id_key" ON "mod_payouts_account"("stripe_account_id");

-- CreateIndex
CREATE INDEX "mod_payouts_account_tenant_id_status_idx" ON "mod_payouts_account"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_payouts_object_ref_tenant_id_kind_idx" ON "mod_payouts_object_ref"("tenant_id", "kind");

-- CreateIndex
CREATE INDEX "mod_payouts_object_ref_parent_object_id_idx" ON "mod_payouts_object_ref"("parent_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_sale_stripe_charge_id_key" ON "mod_payouts_sale"("stripe_charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_sale_stripe_transfer_id_key" ON "mod_payouts_sale"("stripe_transfer_id");

-- CreateIndex
CREATE INDEX "mod_payouts_sale_tenant_id_status_idx" ON "mod_payouts_sale"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_payouts_sale_tenant_id_charged_at_idx" ON "mod_payouts_sale"("tenant_id", "charged_at" DESC);

-- CreateIndex
CREATE INDEX "mod_payouts_sale_tenant_id_source_kind_source_ref_idx" ON "mod_payouts_sale"("tenant_id", "source_kind", "source_ref");

-- CreateIndex
CREATE INDEX "mod_payouts_sale_status_next_attempt_at_idx" ON "mod_payouts_sale"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "mod_payouts_sale_account_id_idx" ON "mod_payouts_sale"("account_id");

-- CreateIndex
CREATE INDEX "mod_payouts_sale_stripe_payment_intent_id_idx" ON "mod_payouts_sale"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "mod_payouts_sale_stripe_invoice_id_idx" ON "mod_payouts_sale"("stripe_invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_ledger_entry_idempotency_key_key" ON "mod_payouts_ledger_entry"("idempotency_key");

-- CreateIndex
CREATE INDEX "mod_payouts_ledger_entry_tenant_id_account_id_currency_idx" ON "mod_payouts_ledger_entry"("tenant_id", "account_id", "currency");

-- CreateIndex
CREATE INDEX "mod_payouts_ledger_entry_tenant_id_occurred_at_idx" ON "mod_payouts_ledger_entry"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "mod_payouts_ledger_entry_sale_id_idx" ON "mod_payouts_ledger_entry"("sale_id");

-- CreateIndex
CREATE INDEX "mod_payouts_debt_tenant_id_account_id_status_currency_idx" ON "mod_payouts_debt"("tenant_id", "account_id", "status", "currency");

-- CreateIndex
CREATE INDEX "mod_payouts_debt_origin_sale_id_idx" ON "mod_payouts_debt"("origin_sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_refund_stripe_refund_id_key" ON "mod_payouts_refund"("stripe_refund_id");

-- CreateIndex
CREATE INDEX "mod_payouts_refund_tenant_id_sale_id_idx" ON "mod_payouts_refund"("tenant_id", "sale_id");

-- CreateIndex
CREATE INDEX "mod_payouts_refund_sale_id_idx" ON "mod_payouts_refund"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_dispute_stripe_dispute_id_key" ON "mod_payouts_dispute"("stripe_dispute_id");

-- CreateIndex
CREATE INDEX "mod_payouts_dispute_tenant_id_status_idx" ON "mod_payouts_dispute"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mod_payouts_dispute_sale_id_idx" ON "mod_payouts_dispute"("sale_id");

-- CreateIndex
CREATE INDEX "mod_payouts_webhook_event_tenant_id_received_at_idx" ON "mod_payouts_webhook_event"("tenant_id", "received_at");

-- CreateIndex
CREATE INDEX "mod_payouts_webhook_event_type_idx" ON "mod_payouts_webhook_event"("type");

-- CreateIndex
CREATE INDEX "mod_payouts_webhook_event_processed_at_received_at_idx" ON "mod_payouts_webhook_event"("processed_at", "received_at");

-- AddForeignKey
ALTER TABLE "mod_payouts_sale" ADD CONSTRAINT "mod_payouts_sale_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "mod_payouts_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_payouts_ledger_entry" ADD CONSTRAINT "mod_payouts_ledger_entry_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "mod_payouts_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_payouts_ledger_entry" ADD CONSTRAINT "mod_payouts_ledger_entry_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "mod_payouts_sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_payouts_debt" ADD CONSTRAINT "mod_payouts_debt_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "mod_payouts_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_payouts_debt" ADD CONSTRAINT "mod_payouts_debt_origin_sale_id_fkey" FOREIGN KEY ("origin_sale_id") REFERENCES "mod_payouts_sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_payouts_refund" ADD CONSTRAINT "mod_payouts_refund_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "mod_payouts_sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_payouts_dispute" ADD CONSTRAINT "mod_payouts_dispute_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "mod_payouts_sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

