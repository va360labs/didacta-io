-- Idempotencia del aviso de caducidad para los accesos con vigencia (TIMED).
--
-- El worker diario ya avisa con 7 días a las suscripciones de verdad, usando
-- `mod_payment_connections_subscriber.renewal_warned_period_end`. Los accesos
-- de pago único con vigencia no estaban cubiertos porque viven en otra tabla:
-- de 53 vendidos, 50 caducaron sin que nadie se enterara.
--
-- Guarda el `access_ends_at` para el que ya se avisó, así que un cambio de
-- fecha (recompra, corrección) vuelve a habilitar el aviso.

ALTER TABLE "mod_payment_connections_order"
    ADD COLUMN IF NOT EXISTS "expiry_warned_for" TIMESTAMP(3);
