-- Espejo del histórico de pedidos de una tienda externa (WooCommerce).
--
-- Nace para que la ficha del alumno pueda decir qué compró, cuándo y por
-- cuánto: hoy el expediente lee `mod_billing_order`, que solo tiene las ventas
-- hechas DENTRO de Didacta vía Stripe (3 filas), mientras el histórico real
-- vive en la tienda (871 pedidos, 110.196 € facturados).
--
-- No es fuente de verdad: la tienda sigue cobrando y mandando. Por eso la clave
-- natural es (tenant, provider, external_id) y todo se escribe con upsert — una
-- resincronización jamás duplica.
--
-- user_id es NULLABLE a propósito: el email de facturación puede ser el de la
-- pasarela de pago y no coincidir con ninguna cuenta. Ese pedido se guarda
-- igual, y se puede reclamar cuando la persona se dé de alta.
--
-- tenant_id NOT NULL: la política RLS genérica (rls.sql) cubre toda tabla de
-- public con esa columna, así que queda aislada por tenant sin tocar el script.
--
-- Nota: el flujo real de despliegue es `prisma db push`. Este fichero deja el
-- histórico coherente para quien reconstruya la base desde cero.

CREATE TABLE IF NOT EXISTS "mod_payment_connections_order" (
    "id"            UUID         NOT NULL,
    "tenant_id"     UUID         NOT NULL,
    "connection_id" UUID,
    "provider"      TEXT         NOT NULL,
    "external_id"   TEXT         NOT NULL,

    "user_id"        UUID,
    "customer_email" TEXT        NOT NULL,
    "customer_name"  TEXT,

    -- Estado crudo de la tienda + normalización de "esto es dinero cobrado".
    "status" TEXT    NOT NULL,
    "paid"   BOOLEAN NOT NULL DEFAULT false,

    "total_amount" INTEGER      NOT NULL,
    "currency"     TEXT         NOT NULL DEFAULT 'eur',
    "placed_at"    TIMESTAMP(3) NOT NULL,
    "paid_at"      TIMESTAMP(3),
    "refunded_at"  TIMESTAMP(3),

    -- LIFETIME | SUBSCRIPTION | TIMED | ONE_OFF | INFRA (ver entitlement-rules.ts).
    "entitlement_kind" TEXT NOT NULL,
    -- Solo para TIMED: pago único con vigencia, del que la tienda nunca avisará.
    "access_ends_at"   TIMESTAMP(3),

    "items"     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_payment_connections_order_pkey" PRIMARY KEY ("id")
);

-- Clave natural: reimportar la tienda entera actualiza, no duplica.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_conn_order_unique"
    ON "mod_payment_connections_order"("tenant_id", "provider", "external_id");

CREATE INDEX IF NOT EXISTS "mod_payment_connections_order_tenant_id_user_id_idx"
    ON "mod_payment_connections_order"("tenant_id", "user_id");

-- El cruce por email es lo que reclama los pedidos huérfanos cuando alguien
-- se da de alta más tarde.
CREATE INDEX IF NOT EXISTS "mod_payment_connections_order_tenant_id_customer_email_idx"
    ON "mod_payment_connections_order"("tenant_id", "customer_email");

CREATE INDEX IF NOT EXISTS "mod_payment_connections_order_tenant_id_entitlement_kind_idx"
    ON "mod_payment_connections_order"("tenant_id", "entitlement_kind");

-- Lo consultará el vigilante de vencimientos (fase B) para los TIMED.
CREATE INDEX IF NOT EXISTS "mod_payment_connections_order_tenant_id_access_ends_at_idx"
    ON "mod_payment_connections_order"("tenant_id", "access_ends_at");
