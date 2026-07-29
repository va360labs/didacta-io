-- Bloque 4 (recursos) — mod.resources: biblioteca de recursos del tenant
-- (workflows de las clases, skills, directorio de herramientas, plantillas).
-- tenant_id NOT NULL a propósito: la política RLS genérica (rls.sql) cubre
-- automáticamente toda tabla de public con columna tenant_id.

CREATE TYPE "ResourceCategory" AS ENUM ('WORKFLOW', 'SKILL', 'TOOL', 'TEMPLATE', 'OTHER');
CREATE TYPE "ResourceKind" AS ENUM ('FILE', 'LINK');

CREATE TABLE "mod_resources_resource" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category" "ResourceCategory" NOT NULL,
    "kind" "ResourceKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT NOT NULL,
    "file_name" TEXT,
    "zoom_session_id" UUID,
    "created_by_id" UUID NOT NULL,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mod_resources_resource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mod_resources_resource_tenant_id_category_created_at_idx"
    ON "mod_resources_resource"("tenant_id", "category", "created_at" DESC);
