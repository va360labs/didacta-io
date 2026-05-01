-- MIG-028: Webhooks salientes — 10º piloto License SDK.
-- Capability EE: feat:api.webhooks.high_throughput.
--
-- Reemplaza el esqueleto previo `webhook` (que nunca se usó: ningún código
-- referencia `prisma.webhook`) por un modelo completo que soporta:
--
--   - CRUD endpoints (community y EE).
--   - Persistencia del secret en plano (HMAC en path EE; community no firma).
--   - Suscripción granular a tipos de eventos.
--   - Dead-letter queue (solo path EE) — histórica, sobrevive al delete del
--     endpoint para auditoría postmortem.

-- 1. Drop tabla previa no usada.
DROP TABLE IF EXISTS "webhook";

-- 2. webhook_endpoint
CREATE TABLE "webhook_endpoint" (
    "id"          UUID NOT NULL,
    "tenant_id"   UUID NOT NULL,
    "url"         TEXT NOT NULL,
    "secret"      TEXT NOT NULL,
    "event_types" TEXT[] NOT NULL,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_endpoint_tenant_id_url_key"
    ON "webhook_endpoint" ("tenant_id", "url");
CREATE INDEX "webhook_endpoint_tenant_id_active_idx"
    ON "webhook_endpoint" ("tenant_id", "active");

ALTER TABLE "webhook_endpoint"
    ADD CONSTRAINT "webhook_endpoint_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. webhook_dead_letter (solo lo llena path EE)
CREATE TABLE "webhook_dead_letter" (
    "id"          UUID NOT NULL,
    "tenant_id"   UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_type"  TEXT NOT NULL,
    "payload"     JSONB NOT NULL,
    "last_error"  TEXT NOT NULL,
    "attempts"    INTEGER NOT NULL DEFAULT 0,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_dead_letter_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_dead_letter_tenant_id_created_at_idx"
    ON "webhook_dead_letter" ("tenant_id", "created_at");
CREATE INDEX "webhook_dead_letter_endpoint_id_idx"
    ON "webhook_dead_letter" ("endpoint_id");

ALTER TABLE "webhook_dead_letter"
    ADD CONSTRAINT "webhook_dead_letter_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Nota: webhook_dead_letter NO tiene FK a webhook_endpoint a propósito.
-- Si el admin borra el endpoint, el histórico de dead-letters se conserva
-- para análisis postmortem. La columna endpoint_id queda como FK lógica.
