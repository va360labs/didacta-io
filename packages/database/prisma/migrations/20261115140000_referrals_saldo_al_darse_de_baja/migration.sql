-- Referidos: baja con saldo de descuento sin usar.
--
-- Al cancelar la membresía, el saldo de referidos que siga a favor en el
-- cliente de Stripe se retira (transacción de saldo POSITIVA, idempotente) y
-- vuelve a la cartera del alumno como comisión confirmada, para cobrarla en
-- dinero. Rastro en el ledger de referidos:
--   - una liquidación `CREDIT_REVERSAL` (PENDING → DONE con el `cbtxn_…`),
--     a lo sumo una pendiente por cliente;
--   - una fila de comisión `kind = 'CREDIT_RETURN'` APPROVED con lo devuelto.
ALTER TABLE "mod_referrals_commission" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'COMMISSION';
CREATE UNIQUE INDEX "mod_referrals_payout_one_pending_reversal"
  ON "mod_referrals_payout" ("tenant_id", "stripe_customer_id")
  WHERE "method" = 'CREDIT_REVERSAL' AND "status" = 'PENDING';
