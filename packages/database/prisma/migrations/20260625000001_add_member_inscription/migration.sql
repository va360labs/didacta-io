-- Inscripción de miembros (gate Telegram + OTP + validación manual).
-- NOTA: el deploy usa `prisma db push` (entrypoint.sh), no `migrate deploy`.
-- Esta migración es para paridad/histórico y dev (`prisma migrate dev`).
-- El índice único PARCIAL de telegram_id se aplica también vía rls.sql.

-- AlterTable: campos de inscripción de miembros en user
ALTER TABLE "user" ADD COLUMN "telegram_id" VARCHAR(32);
ALTER TABLE "user" ADD COLUMN "telegram_in_group" BOOLEAN;
ALTER TABLE "user" ADD COLUMN "approval_decided_at" TIMESTAMP(3);

-- CreateIndex (no único; el único parcial WHERE telegram_id IS NOT NULL va aparte)
CREATE INDEX "user_tenant_telegram_idx" ON "user"("tenant_id", "telegram_id");

-- CreateEnum
CREATE TYPE "MemberDecisionAction" AS ENUM ('APPROVE', 'REJECT');

-- CreateTable: email_verification_code (OTP del paso 1.5)
CREATE TABLE "email_verification_code" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "request_ip" TEXT,
    "request_ua" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_verification_code_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "email_verification_code_tenant_id_email_idx" ON "email_verification_code"("tenant_id", "email");
CREATE INDEX "email_verification_code_expires_at_idx" ON "email_verification_code"("expires_at");

-- CreateTable: member_registration_decision_token (enlaces aprobar/rechazar)
CREATE TABLE "member_registration_decision_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" "MemberDecisionAction" NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "request_ip" TEXT,
    "request_ua" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "member_registration_decision_token_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "member_registration_decision_token_token_hash_key" ON "member_registration_decision_token"("token_hash");
CREATE INDEX "member_registration_decision_token_tenant_id_user_id_idx" ON "member_registration_decision_token"("tenant_id", "user_id");
CREATE INDEX "member_registration_decision_token_expires_at_idx" ON "member_registration_decision_token"("expires_at");

-- CreateTable: member_payment_flag (lista de impagos gestionada por el admin)
CREATE TABLE "member_payment_flag" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "telegram_id" VARCHAR(32) NOT NULL,
    "name" TEXT,
    "is_delinquent" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "member_payment_flag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "member_payment_flag_tenant_tg_key" ON "member_payment_flag"("tenant_id", "telegram_id");
CREATE INDEX "member_payment_flag_tenant_id_is_delinquent_idx" ON "member_payment_flag"("tenant_id", "is_delinquent");

-- Índice único PARCIAL de telegram_id por tenant (también en rls.sql, idempotente)
CREATE UNIQUE INDEX "user_tenant_telegram_id_key" ON "user"("tenant_id", "telegram_id") WHERE "telegram_id" IS NOT NULL;
