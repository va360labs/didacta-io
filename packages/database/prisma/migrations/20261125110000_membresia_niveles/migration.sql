-- mod.subscriptions — niveles de la membresía (Básico, Pro, Gratis…).
--
-- 1) `mod_subscriptions_tier`: cada nivel con su grupo de acceso propio
--    (mod.access-groups, id lógico sin FK), si es gratis, su orden y si está
--    a la venta.
-- 2) `mod_subscriptions_plan.tier_id`: el nivel del plan. NULL = el plan de
--    siempre, que da el grupo de la configuración de la membresía: las aulas
--    que no crean niveles no cambian nada.
--
-- Todo aditivo: una tabla nueva y una columna nullable (solo catálogo). RLS:
-- la tabla tiene `tenant_id` y la cubre la política genérica de `rls.sql`.

-- AlterTable
ALTER TABLE "mod_subscriptions_plan" ADD COLUMN "tier_id" UUID;

-- CreateTable
CREATE TABLE "mod_subscriptions_tier" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "access_group_id" UUID,
    "is_free" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_subscriptions_tier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mod_subscriptions_plan_tenant_id_tier_id_idx" ON "mod_subscriptions_plan"("tenant_id", "tier_id");

-- CreateIndex
CREATE INDEX "mod_subscriptions_tier_tenant_id_active_sort_order_idx" ON "mod_subscriptions_tier"("tenant_id", "active", "sort_order");
