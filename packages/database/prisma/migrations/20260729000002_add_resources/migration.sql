-- Bloque 4 (recursos) — mod.resources: biblioteca de recursos por colecciones
-- ("Workflows de clase", "Skills y agentes"…), cada una con su portada.
-- tenant_id NOT NULL a propósito: la política RLS genérica (rls.sql) cubre
-- automáticamente toda tabla de public con columna tenant_id.
-- Las 6 colecciones por defecto se siembran en RUNTIME (lazy, al primer
-- listado del tenant): el flujo real de despliegue es `prisma db push`, que
-- ignora los INSERT de esta carpeta.

CREATE TYPE "ResourceKind" AS ENUM ('FILE', 'LINK');

CREATE TABLE "mod_resources_collection" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "cover_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mod_resources_collection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_resources_collection_tenant_id_title_key"
    ON "mod_resources_collection"("tenant_id", "title");
CREATE INDEX "mod_resources_collection_tenant_id_sort_order_idx"
    ON "mod_resources_collection"("tenant_id", "sort_order");

CREATE TABLE "mod_resources_resource" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
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

CREATE INDEX "mod_resources_resource_tenant_id_collection_id_created_at_idx"
    ON "mod_resources_resource"("tenant_id", "collection_id", "created_at" DESC);

ALTER TABLE "mod_resources_resource"
    ADD CONSTRAINT "mod_resources_resource_collection_id_fkey"
    FOREIGN KEY ("collection_id") REFERENCES "mod_resources_collection"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
