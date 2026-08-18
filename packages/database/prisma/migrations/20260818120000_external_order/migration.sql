-- Compras hechas fuera — el historial del alumno cuando la tienda no es Didacta.
--
-- Tabla NUEVA y nada más. No se altera ninguna tabla existente, no se escribe
-- ninguna fila y no cambia el comportamiento de nadie: una instalación que
-- actualice se queda exactamente como estaba, con la tabla vacía, hasta que una
-- tienda externa llame a `POST /api/v1/integrations/orders`.
--
-- Lleva `tenant_id`, así que `rls.sql` le aplica sola la política de aislamiento
-- por tenant al reaplicarse tras la migración.
--
-- `user_id` va SIN clave foránea a propósito. La fila puede nacer antes de que
-- el alumno exista en el aula —la tienda cobra, manda el pedido y solo después
-- llama a `/inscribe`—, y una FK obligaría a la tienda a ordenar sus llamadas
-- para no fallar. El campo se resuelve por email al escribir y la lectura busca
-- por `user_id` O por `email`, así que un null no esconde el pedido de nadie.
CREATE TYPE "ExternalOrderStatus" AS ENUM ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED');

CREATE TABLE "external_order" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "email" TEXT NOT NULL,
    "source" VARCHAR(60) NOT NULL,
    "reference" VARCHAR(100) NOT NULL,
    "status" "ExternalOrderStatus" NOT NULL DEFAULT 'PAID',
    "amount_cents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'eur',
    "lines" JSONB NOT NULL DEFAULT '[]',
    "invoice_number" VARCHAR(60),
    "invoice_issued_at" TIMESTAMP(3),
    "invoice_url" TEXT,
    "order_url" TEXT,
    "placed_at" TIMESTAMP(3) NOT NULL,
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_order_pkey" PRIMARY KEY ("id")
);

-- La idempotencia del endpoint: la tienda reintenta y no duplica.
CREATE UNIQUE INDEX "external_order_tenant_id_source_reference_key" ON "external_order"("tenant_id", "source", "reference");

-- El listado del perfil: los pedidos de una persona, por fecha de compra.
CREATE INDEX "external_order_tenant_id_user_id_placed_at_idx" ON "external_order"("tenant_id", "user_id", "placed_at");

-- La misma lista cuando la cuenta del aula todavía no existe.
CREATE INDEX "external_order_tenant_id_email_idx" ON "external_order"("tenant_id", "email");

ALTER TABLE "external_order" ADD CONSTRAINT "external_order_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
