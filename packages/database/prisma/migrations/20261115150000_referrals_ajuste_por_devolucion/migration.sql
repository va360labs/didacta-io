-- Referidos: comisiones de ventas devueltas.
--
-- 1) Reembolso parcial: la comisión se recorta en proporción. Se guarda la
--    parte de la base ya devuelta (acumulada) para que un evento reentregado
--    no recorte dos veces.
-- 2) Venta devuelta cuya comisión ya se cobró (en dinero o como descuento):
--    fila `kind = 'ADJUSTMENT'` con importe NEGATIVO, APPROVED y sin liquidar,
--    que se descuenta de lo siguiente que gane. Nunca deja un saldo exigible:
--    si no gana más, se queda ahí.
ALTER TABLE "mod_referrals_commission" ADD COLUMN "refunded_base_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "mod_referrals_commission" ADD COLUMN "adjusts_commission_id" UUID;
