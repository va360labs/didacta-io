-- Viaje 2 público (F4): el checkout anónimo de mod.billing crea la order
-- ANTES de conocer al comprador (patrón order-first, imprescindible para la
-- reconciliación por metadata.orderId). El user_id pasa a nullable y lo
-- rellena el fulfillment del webhook al materializar la cuenta por el email
-- confirmado en Stripe. No destructivo: las filas existentes no cambian.
ALTER TABLE "mod_billing_order" ALTER COLUMN "user_id" DROP NOT NULL;
