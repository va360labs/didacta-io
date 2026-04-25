-- AlterEnum
-- Postgres exige commit antes de usar el nuevo valor del enum, así que esta
-- migración solo lo añade. El backend del API ya soporta FILL_IN_BLANK pero
-- no lo expondrá hasta que esta migración esté aplicada en el deploy.
ALTER TYPE "QuestionType" ADD VALUE 'FILL_IN_BLANK';

-- AlterTable
ALTER TABLE "mod_assessments_question"
  ADD COLUMN "accepted_answers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "mod_assessments_answer"
  ADD COLUMN "text_answer" TEXT;
