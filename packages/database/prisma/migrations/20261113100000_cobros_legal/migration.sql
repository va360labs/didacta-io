-- Condiciones legales de los cobros de plataforma (antes del lanzamiento de
-- Didacta Cloud).
--
-- Solo AÑADE: dos enumerados y seis tablas nuevas. No altera ninguna tabla
-- existente ni escribe una sola fila.
--
--  - `purchase_consent` (host): prueba de la renuncia al desistimiento que da
--    el comprador antes de pagar contenido digital (art. 103.m TRLGDCU).
--  - `mod_payouts_tax_profile`: datos fiscales del creador (factura y DAC7),
--    lo identificativo cifrado.
--  - `mod_payouts_invoice` + `mod_payouts_invoice_item`: factura mensual de la
--    comisión del operador al creador, y sus líneas.
--  - `mod_payouts_invoice_counter`: contador GLOBAL de cada serie (la
--    numeración es del emisor, no de cada aula). Es la única sin `tenant_id`.
--
-- Las que llevan `tenant_id` reciben solas la política de aislamiento al
-- reaplicarse `rls.sql`, que además congela la prueba del consentimiento y las
-- facturas emitidas (triggers).

-- CreateEnum
CREATE TYPE "PayoutsInvoiceKind" AS ENUM ('ORDINARY', 'RECTIFYING');

-- CreateEnum
CREATE TYPE "PayoutsVatRegime" AS ENUM ('ES_VAT', 'EU_REVERSE_CHARGE', 'ES_VAT_EU_NO_VAT_ID', 'NOT_SUBJECT_OUTSIDE_EU', 'NOT_SUBJECT_ES_SPECIAL_TERRITORY');

-- CreateTable
CREATE TABLE "purchase_consent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "purchase_kind" TEXT NOT NULL,
    "item_ref" TEXT NOT NULL,
    "item_name" TEXT,
    "order_id" UUID,
    "stripe_checkout_session_id" TEXT,
    "user_id" UUID,
    "buyer_email" TEXT,
    "seller_name" TEXT NOT NULL,
    "payment_mode" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "locale" VARCHAR(16) NOT NULL,
    "text" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "accepted_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "confirmation_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payouts_tax_profile" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "sensitive_cipher" BYTEA NOT NULL,
    "sensitive_iv" BYTEA NOT NULL,
    "sensitive_tag" BYTEA NOT NULL,
    "tax_id_hint" TEXT,
    "has_vat_id" BOOLEAN NOT NULL DEFAULT false,
    "vat_status" TEXT NOT NULL DEFAULT 'not_applicable',
    "vat_checked_at" TIMESTAMP(3),
    "vat_checked_hash" TEXT,
    "vat_consultation" TEXT,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payouts_tax_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payouts_invoice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" "PayoutsInvoiceKind" NOT NULL,
    "series" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "full_number" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "issue_date" DATE NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "regime" "PayoutsVatRegime" NOT NULL,
    "vat_rate_bps" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "tax_base" INTEGER NOT NULL,
    "vat_amount" INTEGER NOT NULL,
    "issuer" JSONB NOT NULL,
    "recipient_legal_name" TEXT NOT NULL,
    "recipient_country" VARCHAR(2) NOT NULL,
    "recipient_entity_type" TEXT NOT NULL,
    "recipient_complete" BOOLEAN NOT NULL,
    "rectifies" JSONB NOT NULL DEFAULT '[]',
    "rectification_reason" TEXT,
    "replaced_by_id" UUID,
    "document_cipher" BYTEA NOT NULL,
    "document_iv" BYTEA NOT NULL,
    "document_tag" BYTEA NOT NULL,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "emailed_at" TIMESTAMP(3),
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_payouts_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payouts_invoice_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "sale_id" UUID,
    "ledger_entry_id" UUID NOT NULL,
    "consumes_ledger_entry_id" UUID,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "sale_gross" INTEGER,
    "amount" INTEGER NOT NULL,
    "original_invoice_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_payouts_invoice_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_payouts_invoice_counter" (
    "series" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_payouts_invoice_counter_pkey" PRIMARY KEY ("series")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_consent_stripe_checkout_session_id_key" ON "purchase_consent"("stripe_checkout_session_id");

-- CreateIndex
CREATE INDEX "purchase_consent_tenant_id_accepted_at_idx" ON "purchase_consent"("tenant_id", "accepted_at");

-- CreateIndex
CREATE INDEX "purchase_consent_order_id_idx" ON "purchase_consent"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_tax_profile_tenant_id_key" ON "mod_payouts_tax_profile"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_invoice_full_number_key" ON "mod_payouts_invoice"("full_number");

-- CreateIndex
CREATE INDEX "mod_payouts_invoice_tenant_id_issue_date_idx" ON "mod_payouts_invoice"("tenant_id", "issue_date" DESC);

-- CreateIndex
CREATE INDEX "mod_payouts_invoice_emailed_at_idx" ON "mod_payouts_invoice"("emailed_at");

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_invoice_series_number_key" ON "mod_payouts_invoice"("series", "number");

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_invoice_tenant_id_slot_key" ON "mod_payouts_invoice"("tenant_id", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "mod_payouts_invoice_item_consumes_ledger_entry_id_key" ON "mod_payouts_invoice_item"("consumes_ledger_entry_id");

-- CreateIndex
CREATE INDEX "mod_payouts_invoice_item_tenant_id_invoice_id_idx" ON "mod_payouts_invoice_item"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "mod_payouts_invoice_item_sale_id_idx" ON "mod_payouts_invoice_item"("sale_id");

-- AddForeignKey
ALTER TABLE "mod_payouts_invoice_item" ADD CONSTRAINT "mod_payouts_invoice_item_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "mod_payouts_invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
