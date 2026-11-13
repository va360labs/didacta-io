-- Facturación del descuento por referidos en la cuota.
--
-- La cuota se factura ENTERA (`total_cents`, el `total` de Stripe) y el
-- descuento figura aparte como «Pago con saldo de referidos»
-- (`credit_applied_cents`, el saldo a favor que Stripe gastó). `amount` sigue
-- siendo lo cobrado (cuota − saldo), como hasta ahora. Coincide con la base de
-- la comisión de la plataforma (`mod_payouts_sale.fee_base`).
-- ADD COLUMN nullable / con DEFAULT constante: solo catálogo.
ALTER TABLE "mod_subscriptions_invoice" ADD COLUMN "total_cents" INTEGER;
ALTER TABLE "mod_subscriptions_invoice" ADD COLUMN "credit_applied_cents" INTEGER NOT NULL DEFAULT 0;
