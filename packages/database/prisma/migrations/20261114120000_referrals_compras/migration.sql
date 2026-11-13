-- Referidos para todo: la atribución ya no exige una suscripción.
--
-- Hasta ahora un referido solo nacía del alta de una MEMBRESÍA (la fila
-- guardaba la suscripción de Stripe y la local). Ahora también nace de la
-- compra de un curso suelto (mod.billing): en ese caso no hay suscripción y la
-- fila apunta a la orden que la originó (`order_id`, ID lógico sin FK —
-- ADR-016: nada de FKs entre módulos).
--
-- Las filas existentes no cambian. `DROP NOT NULL` y `ADD COLUMN` nullable son
-- solo de catálogo: no reescriben la tabla. El índice único de
-- `stripe_subscription_id` sigue valiendo (Postgres admite varios NULL).
ALTER TABLE "mod_referrals_referral" ALTER COLUMN "stripe_subscription_id" DROP NOT NULL;
ALTER TABLE "mod_referrals_referral" ALTER COLUMN "subscription_id" DROP NOT NULL;
ALTER TABLE "mod_referrals_referral" ADD COLUMN "order_id" UUID;
