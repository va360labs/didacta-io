-- Lookup automático de la suscripción de un miembro al inscribirse.
-- NOTA: el deploy usa `prisma db push` (entrypoint.sh), no `migrate deploy`.
-- Esta migración es para paridad/histórico y dev (`prisma migrate dev`).
-- Tabla CORE del host (no de módulo): no lleva RLS, el service filtra por
-- tenant_id explícitamente (igual que el resto del flujo de inscripción).

-- CreateTable
CREATE TABLE "member_subscription_lookup" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "results" JSONB NOT NULL DEFAULT '[]',
    "match_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "member_subscription_lookup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_subscription_lookup_tenant_user_key" ON "member_subscription_lookup"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "member_subscription_lookup_tenant_id_idx" ON "member_subscription_lookup"("tenant_id");
