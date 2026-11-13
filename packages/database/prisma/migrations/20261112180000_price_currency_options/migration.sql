-- Multidivisa (cobros de plataforma, E8): precios fijos extra por mercado
-- (`currency_options` de Stripe) en la opción de compra de un curso y en el
-- plan de la membresía. Aditiva y nula: lo existente no cambia.

-- AlterTable
ALTER TABLE "mod_billing_product" ADD COLUMN "currency_options" JSONB;

-- AlterTable
ALTER TABLE "mod_subscriptions_plan" ADD COLUMN "currency_options" JSONB;
