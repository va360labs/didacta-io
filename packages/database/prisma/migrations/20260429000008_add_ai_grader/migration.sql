-- LMS-91.A: mod.ai-grader — rúbrica + sugerencias IA para corrección de respuestas abiertas.

CREATE TABLE "mod_ai_grader_rubric" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "instructions" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_ai_grader_rubric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_ai_grader_rubric_question_id_key"
    ON "mod_ai_grader_rubric" ("question_id");

CREATE INDEX "mod_ai_grader_rubric_tenant_idx"
    ON "mod_ai_grader_rubric" ("tenant_id");

CREATE TABLE "mod_ai_grader_suggestion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "answer_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "proposed_score" INTEGER NOT NULL,
    "per_criterion" JSONB NOT NULL,
    "overall_feedback" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "applied_by_id" UUID,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_ai_grader_suggestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_ai_grader_suggestion_attempt_answer_key"
    ON "mod_ai_grader_suggestion" ("attempt_id", "answer_id");

CREATE INDEX "mod_ai_grader_suggestion_tenant_attempt_idx"
    ON "mod_ai_grader_suggestion" ("tenant_id", "attempt_id");
