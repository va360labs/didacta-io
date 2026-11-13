-- Referidos: cobrar lo ganado como descuento en la próxima cuota.
--
-- 1) El creador puede apagar la opción en Ventas (encendida por defecto).
-- 2) Una liquidación puede ser en dinero (CASH, la de siempre) o un abono en
--    el saldo de cliente de Stripe (CREDIT). La de CREDIT nace PENDING y pasa a
--    DONE con el id de la transacción de saldo en `external_reference`.
--    A lo sumo UNA pendiente por alumno y aula: el índice parcial impide que
--    dos canjes a la vez abran dos abonos.
-- 3) Modo plataforma: la venta guarda el saldo a favor que Stripe aplicó a la
--    factura y la base de la comisión del operador (bruto + ese saldo), para
--    que el descuento lo pague el creador y nunca el operador.
--
-- Todo son ADD COLUMN con DEFAULT constante o nullable: solo catálogo, no
-- reescribe las tablas. Las filas existentes quedan CASH/DONE y sin saldo.
ALTER TABLE "mod_referrals_config" ADD COLUMN "allow_credit_redemption" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "mod_referrals_payout" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'CASH';
ALTER TABLE "mod_referrals_payout" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DONE';
ALTER TABLE "mod_referrals_payout" ADD COLUMN "stripe_customer_id" TEXT;
CREATE UNIQUE INDEX "mod_referrals_payout_one_pending_credit"
  ON "mod_referrals_payout" ("tenant_id", "referrer_user_id")
  WHERE "method" = 'CREDIT' AND "status" = 'PENDING';

ALTER TABLE "mod_payouts_sale" ADD COLUMN "customer_credit_applied" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "mod_payouts_sale" ADD COLUMN "fee_base" INTEGER;
