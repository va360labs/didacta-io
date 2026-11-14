-- mod.retention — mensajes automáticos y miembros en riesgo.
--
-- Solo AÑADE: dos enumerados y tres tablas `mod_retention_*` con sus índices.
-- No altera ninguna tabla existente ni escribe una sola fila: un aula que
-- actualice se queda exactamente igual hasta que su administración active un
-- mensaje (sin fila de ajustes = valores por defecto; sin mensajes activos, el
-- barrido ni siquiera entra en el aula).
--
-- Las tres llevan `tenant_id`, así que `rls.sql` les aplica sola la política
-- de aislamiento por aula al reaplicarse tras la migración. La única clave
-- foránea es ENTRE tablas del módulo (envío → mensaje); el destinatario, el
-- remitente y el mensaje directo son ids sin clave foránea (ADR-016/039).

-- CreateEnum
CREATE TYPE "RetentionTrigger" AS ENUM ('WELCOME', 'DAYS_AFTER_JOIN', 'INACTIVE', 'COURSE_COMPLETED', 'FIRST_POST', 'LEVEL_UP', 'ANNIVERSARY');

-- CreateEnum
CREATE TYPE "RetentionDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "mod_retention_settings" (
    "tenant_id" UUID NOT NULL,
    "sender_user_id" UUID,
    "manual_cooldown_hours" INTEGER NOT NULL DEFAULT 24,
    "send_window_start_hour" INTEGER NOT NULL DEFAULT 9,
    "send_window_end_hour" INTEGER NOT NULL DEFAULT 21,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_retention_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "mod_retention_automation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trigger" "RetentionTrigger" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "template_key" VARCHAR(40),
    "days" INTEGER,
    "resend_after_days" INTEGER,
    "body" TEXT NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "email_subject" VARCHAR(200),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "activated_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "mod_retention_automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_retention_delivery" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "automation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "occurrence_key" VARCHAR(120) NOT NULL,
    "status" "RetentionDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "due_at" TIMESTAMP(3) NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMP(3),
    "conversation_id" UUID,
    "message_id" UUID,
    "email_sent_at" TIMESTAMP(3),
    "email_skip_reason" VARCHAR(60),
    "read_at" TIMESTAMP(3),
    "replied_at" TIMESTAMP(3),
    "skip_reason" VARCHAR(60),
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_retention_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mod_retention_automation_tenant_id_enabled_idx" ON "mod_retention_automation"("tenant_id", "enabled");

-- CreateIndex
CREATE INDEX "mod_retention_automation_enabled_deleted_at_idx" ON "mod_retention_automation"("enabled", "deleted_at");

-- CreateIndex
CREATE INDEX "mod_retention_delivery_tenant_id_status_due_at_idx" ON "mod_retention_delivery"("tenant_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "mod_retention_delivery_tenant_id_user_id_sent_at_idx" ON "mod_retention_delivery"("tenant_id", "user_id", "sent_at");

-- CreateIndex
CREATE INDEX "mod_retention_delivery_tenant_id_automation_id_status_idx" ON "mod_retention_delivery"("tenant_id", "automation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mod_retention_delivery_once" ON "mod_retention_delivery"("tenant_id", "automation_id", "user_id", "occurrence_key");

-- AddForeignKey
ALTER TABLE "mod_retention_delivery" ADD CONSTRAINT "mod_retention_delivery_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "mod_retention_automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

