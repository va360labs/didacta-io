-- Correos de venta tipo recibo.
--
-- Solo AÑADE una tabla del host: el sello de idempotencia de los correos que
-- salen por un evento repetible de Stripe (recibo de cada renovación y aviso
-- de cobro fallido). No altera ninguna tabla existente ni escribe filas.
--
-- Lleva `tenant_id`: recibe sola la política de aislamiento al reaplicarse
-- `rls.sql`.

-- CreateTable
CREATE TABLE "sale_email_sent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "ref" VARCHAR(200) NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_email_sent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sale_email_sent_tenant_id_kind_ref_key" ON "sale_email_sent"("tenant_id", "kind", "ref");
