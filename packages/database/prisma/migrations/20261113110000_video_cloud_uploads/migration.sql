-- Vídeo subido a Bunny Stream (Didacta Cloud).
--
-- Solo AÑADE: un enumerado y tres tablas (`video_asset`, `video_usage_month`,
-- `video_tenant_state`) con sus índices. No altera ninguna tabla existente ni
-- escribe una sola fila: una instalación que actualice se queda igual, con las
-- tablas vacías, mientras su operador no defina `BUNNY_STREAM_*`.
--
-- Las tres llevan `tenant_id`, así que `rls.sql` les aplica sola la política
-- de aislamiento por tenant al reaplicarse tras la migración. Sin claves
-- foráneas: la lección y el usuario son ids lógicos.

-- CreateEnum
CREATE TYPE "VideoAssetStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'DELETED');

-- CreateTable
CREATE TABLE "video_asset" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lesson_id" UUID,
    "library_id" VARCHAR(20) NOT NULL,
    "bunny_guid" VARCHAR(36) NOT NULL,
    "collection_id" VARCHAR(36),
    "title" VARCHAR(200) NOT NULL,
    "status" "VideoAssetStatus" NOT NULL DEFAULT 'UPLOADING',
    "failure_reason" VARCHAR(40),
    "declared_bytes" BIGINT NOT NULL,
    "declared_seconds" INTEGER NOT NULL,
    "duration_seconds" INTEGER,
    "storage_bytes" BIGINT,
    "max_resolution" VARCHAR(8) NOT NULL,
    "available_resolutions" VARCHAR(120),
    "resolutions_capped" BOOLEAN NOT NULL DEFAULT false,
    "watch_seconds_total" BIGINT NOT NULL DEFAULT 0,
    "last_played_at" TIMESTAMP(3),
    "unreferenced_since" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "delete_reason" VARCHAR(40),
    "backup_drive_file_id" VARCHAR(200),
    "backup_bytes" BIGINT,
    "backup_at" TIMESTAMP(3),
    "backup_expires_at" TIMESTAMP(3),
    "backup_deleted_at" TIMESTAMP(3),
    "backup_error" VARCHAR(300),

    CONSTRAINT "video_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_usage_month" (
    "tenant_id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "watched_seconds" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_usage_month_pkey" PRIMARY KEY ("tenant_id","month")
);

-- CreateTable
CREATE TABLE "video_tenant_state" (
    "tenant_id" UUID NOT NULL,
    "collection_id" VARCHAR(36),
    "collection_name" VARCHAR(120),
    "collection_claimed_at" TIMESTAMP(3),
    "last_activity_at" TIMESTAMP(3),
    "last_activity_source" VARCHAR(40),
    "warned_10_at" TIMESTAMP(3),
    "warned_20_at" TIMESTAMP(3),
    "purge_started_at" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "purge_blocked_reason" VARCHAR(300),
    "cost_alert_month" VARCHAR(7),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_tenant_state_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_asset_bunny_guid_key" ON "video_asset"("bunny_guid");

-- CreateIndex
CREATE INDEX "video_asset_tenant_id_status_idx" ON "video_asset"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "video_asset_tenant_id_lesson_id_idx" ON "video_asset"("tenant_id", "lesson_id");

-- CreateIndex
CREATE INDEX "video_asset_status_updated_at_idx" ON "video_asset"("status", "updated_at");

-- CreateIndex
CREATE INDEX "video_asset_backup_expires_at_idx" ON "video_asset"("backup_expires_at");

