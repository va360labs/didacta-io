-- Bloque 2 (feedback/NPS) — mod.surveys: encuestas post-clase anónimas.
-- tenant_id NOT NULL a propósito: la política RLS genérica (rls.sql) cubre
-- automáticamente toda tabla de public con columna tenant_id.
-- Las respuestas NO guardan user_id: respondent_hash = HMAC(surveyId:userId)
-- con secreto del servidor — dedupe sin identificar al autor.

CREATE TYPE "SurveyKind" AS ENUM ('POST_CLASS', 'POST_COURSE', 'GENERAL');
CREATE TYPE "SurveyStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "SurveyQuestionType" AS ENUM ('NPS', 'SCALE', 'TEXT');

CREATE TABLE "mod_surveys_survey" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "SurveyKind" NOT NULL,
    "zoom_session_id" UUID,
    "course_id" UUID,
    "title" TEXT NOT NULL,
    "status" "SurveyStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "reminder_sent_at" TIMESTAMP(3),
    CONSTRAINT "mod_surveys_survey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_surveys_survey_tenant_id_zoom_session_id_key"
    ON "mod_surveys_survey"("tenant_id", "zoom_session_id");
CREATE INDEX "mod_surveys_survey_tenant_id_kind_created_at_idx"
    ON "mod_surveys_survey"("tenant_id", "kind", "created_at" DESC);

CREATE TABLE "mod_surveys_question" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "SurveyQuestionType" NOT NULL,
    "label" TEXT NOT NULL,
    CONSTRAINT "mod_surveys_question_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_surveys_question_survey_id_position_key"
    ON "mod_surveys_question"("survey_id", "position");
CREATE INDEX "mod_surveys_question_tenant_id_survey_id_idx"
    ON "mod_surveys_question"("tenant_id", "survey_id");

ALTER TABLE "mod_surveys_question"
    ADD CONSTRAINT "mod_surveys_question_survey_id_fkey"
    FOREIGN KEY ("survey_id") REFERENCES "mod_surveys_survey"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "mod_surveys_response" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "respondent_hash" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mod_surveys_response_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_surveys_response_survey_id_respondent_hash_key"
    ON "mod_surveys_response"("survey_id", "respondent_hash");
CREATE INDEX "mod_surveys_response_tenant_id_survey_id_idx"
    ON "mod_surveys_response"("tenant_id", "survey_id");

ALTER TABLE "mod_surveys_response"
    ADD CONSTRAINT "mod_surveys_response_survey_id_fkey"
    FOREIGN KEY ("survey_id") REFERENCES "mod_surveys_survey"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "mod_surveys_answer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "value_int" INTEGER,
    "value_text" TEXT,
    CONSTRAINT "mod_surveys_answer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_surveys_answer_response_id_question_id_key"
    ON "mod_surveys_answer"("response_id", "question_id");
CREATE INDEX "mod_surveys_answer_tenant_id_question_id_idx"
    ON "mod_surveys_answer"("tenant_id", "question_id");

ALTER TABLE "mod_surveys_answer"
    ADD CONSTRAINT "mod_surveys_answer_response_id_fkey"
    FOREIGN KEY ("response_id") REFERENCES "mod_surveys_response"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mod_surveys_answer"
    ADD CONSTRAINT "mod_surveys_answer_question_id_fkey"
    FOREIGN KEY ("question_id") REFERENCES "mod_surveys_question"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
