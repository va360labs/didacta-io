-- CreateTable
CREATE TABLE "notification" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "template_key" TEXT NOT NULL,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "read_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_tenant_id_user_id_read_at_idx" ON "notification"("tenant_id", "user_id", "read_at");

-- CreateIndex
CREATE INDEX "notification_tenant_id_channel_sent_at_idx" ON "notification"("tenant_id", "channel", "sent_at");
