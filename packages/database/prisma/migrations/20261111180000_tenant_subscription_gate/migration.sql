-- Puerta de suscripción del tenant (prueba gratis de Didacta Cloud).
--
-- Una dimensión aparte de `tenant.status`: el aula bloqueada sigue ACTIVE para
-- que su administrador pueda entrar y pagar. Toda fila existente queda en
-- OPEN, que es exactamente el comportamiento de antes: una instalación
-- self-hosted no recibe nunca la llamada que la mueve y no cambia en nada.
--
-- `ADD COLUMN ... NOT NULL DEFAULT` es solo de catálogo en Postgres ≥ 11: no
-- reescribe la tabla. Sin índices: el núcleo solo consulta las filas que NO
-- están en OPEN, y en `tenant` hay una fila por academia.
CREATE TYPE "SubscriptionGateState" AS ENUM ('OPEN', 'TRIAL', 'LOCKED');

ALTER TABLE "tenant" ADD COLUMN "subscription_gate_state" "SubscriptionGateState" NOT NULL DEFAULT 'OPEN';
ALTER TABLE "tenant" ADD COLUMN "subscription_trial_ends_at" TIMESTAMP(3);
ALTER TABLE "tenant" ADD COLUMN "subscription_action_url" TEXT;
ALTER TABLE "tenant" ADD COLUMN "subscription_gate_updated_at" TIMESTAMP(3);
