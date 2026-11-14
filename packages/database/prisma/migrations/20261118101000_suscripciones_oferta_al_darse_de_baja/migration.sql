-- mod.subscriptions — oferta al darse de baja (motivo, pausa y descuento).
--
-- 1) La suscripción puede quedar EN PAUSA (`PAUSED`): Stripe no cobra
--    (`pause_collection` con las facturas anuladas) y no hay acceso hasta el
--    primer cobro tras la pausa. `pause_starts_at` / `pause_ends_at` guardan la
--    ventana aceptada (empieza al acabar el periodo ya pagado).
-- 2) `mod_subscriptions_retention_config`: lo que ofrece cada aula (pausa con
--    meses máximos, descuento con %, meses). Sin fila = todo apagado.
-- 3) `mod_subscriptions_exit`: cada salida (motivo, lo ofrecido, lo elegido).
--    El único (tenant_id, discounted_user_id) hace que el descuento se acepte
--    una vez por persona y aula: la columna solo se rellena en las filas
--    DISCOUNTED y los NULL no chocan.
-- 4) mod.payouts: versión de la configuración del portal de cliente de cada
--    cuenta conectada. La 2 quita «cancelar» del portal: la baja pasa por la
--    oferta del aula. Las existentes (1) se actualizan al abrir el portal.
--
-- Todo aditivo: un valor de enum nuevo, columnas nullable o con DEFAULT
-- constante (solo catálogo) y tablas nuevas. RLS: las dos tablas tienen
-- `tenant_id` y las cubre la política genérica de `rls.sql`.

-- CreateEnum
CREATE TYPE "SubscriptionExitOutcome" AS ENUM ('PAUSED', 'DISCOUNTED', 'CANCELED');

-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PAUSED';

-- AlterTable
ALTER TABLE "mod_subscriptions_subscription" ADD COLUMN     "pause_ends_at" TIMESTAMP(3),
ADD COLUMN     "pause_starts_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "mod_payouts_account" ADD COLUMN     "portal_configuration_version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "mod_subscriptions_retention_config" (
    "tenant_id" UUID NOT NULL,
    "pause_enabled" BOOLEAN NOT NULL DEFAULT false,
    "pause_max_months" INTEGER NOT NULL DEFAULT 3,
    "discount_enabled" BOOLEAN NOT NULL DEFAULT false,
    "discount_percent" INTEGER NOT NULL DEFAULT 30,
    "discount_months" INTEGER NOT NULL DEFAULT 3,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_subscriptions_retention_config_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "mod_subscriptions_exit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "reason_text" TEXT,
    "outcome" "SubscriptionExitOutcome" NOT NULL,
    "offered_pause" BOOLEAN NOT NULL DEFAULT false,
    "offered_discount" BOOLEAN NOT NULL DEFAULT false,
    "pause_months" INTEGER,
    "pause_starts_at" TIMESTAMP(3),
    "pause_ends_at" TIMESTAMP(3),
    "discount_percent" INTEGER,
    "discount_months" INTEGER,
    "discount_duration" TEXT,
    "discount_ends_at" TIMESTAMP(3),
    "stripe_coupon_id" TEXT,
    "discounted_user_id" UUID,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_subscriptions_exit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mod_subscriptions_exit_tenant_id_created_at_idx" ON "mod_subscriptions_exit"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "mod_subscriptions_exit_tenant_id_user_id_idx" ON "mod_subscriptions_exit"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_subscriptions_exit_tenant_id_subscription_id_idx" ON "mod_subscriptions_exit"("tenant_id", "subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_subscriptions_exit_tenant_id_discounted_user_id_key" ON "mod_subscriptions_exit"("tenant_id", "discounted_user_id");

-- CreateIndex
CREATE INDEX "mod_subscriptions_subscription_pause_starts_at_idx" ON "mod_subscriptions_subscription"("pause_starts_at");
