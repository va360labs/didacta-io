-- mod.gamification — retención estilo Skool: desbloqueo de contenido por nivel,
-- rachas, insignias, premios automáticos y celebraciones en la comunidad.
--
-- Solo CREA tablas nuevas e índices; no toca ninguna fila ni columna existente.
-- Las únicas FK apuntan a tablas del propio módulo (nivel, cierre, premio):
-- ningún id de curso, sección, post o usuario lleva FK (contrato modular).
-- RLS: todas llevan `tenant_id`, así que `rls.sql` les aplica sola la política
-- `tenant_isolation` (FORCE incluido) al aplicarse tras la migración.

-- CreateTable
CREATE TABLE "mod_gamification_content_lock" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "target_kind" VARCHAR(16) NOT NULL,
    "target_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "level_id" UUID NOT NULL,
    "grant_paid" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_content_lock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_content_unlock" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lock_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "unlocked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_gamification_content_unlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_activity_day" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "day" DATE NOT NULL,

    CONSTRAINT "mod_gamification_activity_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_streak" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "current_days" INTEGER NOT NULL DEFAULT 0,
    "best_days" INTEGER NOT NULL DEFAULT 0,
    "last_day" DATE,
    "current_weeks" INTEGER NOT NULL DEFAULT 0,
    "best_weeks" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_streak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_badge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "threshold" INTEGER NOT NULL DEFAULT 1,
    "name" VARCHAR(80),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_user_badge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "badge_key" VARCHAR(64) NOT NULL,
    "awarded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_gamification_user_badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_reward" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "trigger_kind" VARCHAR(16) NOT NULL,
    "level_id" UUID,
    "points" INTEGER,
    "kind" VARCHAR(16) NOT NULL,
    "message" TEXT,
    "url" TEXT,
    "code" VARCHAR(64),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_reward_grant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reward_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "delivered" JSONB NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_gamification_reward_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "streaks_enabled" BOOLEAN NOT NULL DEFAULT true,
    "badges_enabled" BOOLEAN NOT NULL DEFAULT true,
    "celebrate_courses" BOOLEAN NOT NULL DEFAULT false,
    "celebrate_intros" BOOLEAN NOT NULL DEFAULT false,
    "celebrate_anniversaries" BOOLEAN NOT NULL DEFAULT false,
    "celebrate_levels" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_member_prefs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "celebrate" BOOLEAN NOT NULL DEFAULT true,
    "show_streak" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_member_prefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_celebration" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "day" DATE NOT NULL,
    "post_id" UUID,
    "claimed_at" TIMESTAMP(3),
    "entries" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_gamification_celebration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mod_gamification_celebration_mark" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "subject_key" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_gamification_celebration_mark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mod_gamification_content_lock_tenant_id_course_id_idx" ON "mod_gamification_content_lock"("tenant_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_content_lock_tenant_id_target_kind_target__key" ON "mod_gamification_content_lock"("tenant_id", "target_kind", "target_id");

-- CreateIndex
CREATE INDEX "mod_gamification_content_unlock_tenant_id_user_id_idx" ON "mod_gamification_content_unlock"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_content_unlock_lock_id_user_id_key" ON "mod_gamification_content_unlock"("lock_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_activity_day_tenant_id_user_id_day_key" ON "mod_gamification_activity_day"("tenant_id", "user_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_streak_tenant_id_user_id_key" ON "mod_gamification_streak"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_badge_tenant_id_key_key" ON "mod_gamification_badge"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "mod_gamification_user_badge_tenant_id_user_id_idx" ON "mod_gamification_user_badge"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_user_badge_tenant_id_user_id_badge_key_key" ON "mod_gamification_user_badge"("tenant_id", "user_id", "badge_key");

-- CreateIndex
CREATE INDEX "mod_gamification_reward_tenant_id_active_idx" ON "mod_gamification_reward"("tenant_id", "active");

-- CreateIndex
CREATE INDEX "mod_gamification_reward_grant_tenant_id_granted_at_idx" ON "mod_gamification_reward_grant"("tenant_id", "granted_at" DESC);

-- CreateIndex
CREATE INDEX "mod_gamification_reward_grant_tenant_id_user_id_idx" ON "mod_gamification_reward_grant"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_reward_grant_reward_id_user_id_key" ON "mod_gamification_reward_grant"("reward_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_settings_tenant_id_key" ON "mod_gamification_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_member_prefs_tenant_id_user_id_key" ON "mod_gamification_member_prefs"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_celebration_tenant_id_kind_day_key" ON "mod_gamification_celebration"("tenant_id", "kind", "day");

-- CreateIndex
CREATE UNIQUE INDEX "mod_gamification_celebration_mark_tenant_id_kind_subject_ke_key" ON "mod_gamification_celebration_mark"("tenant_id", "kind", "subject_key");

-- AddForeignKey
ALTER TABLE "mod_gamification_content_lock" ADD CONSTRAINT "mod_gamification_content_lock_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "mod_gamification_level"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_gamification_content_unlock" ADD CONSTRAINT "mod_gamification_content_unlock_lock_id_fkey" FOREIGN KEY ("lock_id") REFERENCES "mod_gamification_content_lock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_gamification_reward" ADD CONSTRAINT "mod_gamification_reward_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "mod_gamification_level"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_gamification_reward_grant" ADD CONSTRAINT "mod_gamification_reward_grant_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "mod_gamification_reward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

