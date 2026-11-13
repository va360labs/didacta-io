-- Referidos: justificante en PDF de cada cobro en dinero marcado pagado.
--
-- Número correlativo POR AULA (único por tenant; NULL mientras no hay
-- justificante) y los datos del receptor congelados al pagar, cifrados como
-- el resto de secretos (los recifra `rotate-cipher-key`).
ALTER TABLE "mod_referrals_payout" ADD COLUMN "receipt_number" INTEGER;
ALTER TABLE "mod_referrals_payout" ADD COLUMN "payee_snapshot_cipher" BYTEA;
ALTER TABLE "mod_referrals_payout" ADD COLUMN "payee_snapshot_iv" BYTEA;
ALTER TABLE "mod_referrals_payout" ADD COLUMN "payee_snapshot_tag" BYTEA;
CREATE UNIQUE INDEX "mod_referrals_payout_tenant_id_receipt_number_key"
  ON "mod_referrals_payout"("tenant_id", "receipt_number");
