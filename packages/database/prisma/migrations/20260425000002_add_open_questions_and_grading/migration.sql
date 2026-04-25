-- AlterEnum: nuevos tipos de pregunta abiertos (sin auto-corrección)
ALTER TYPE "QuestionType" ADD VALUE 'SHORT_ANSWER';
ALTER TYPE "QuestionType" ADD VALUE 'LONG_ANSWER';

-- AlterEnum: estados del attempt para corrección manual
ALTER TYPE "AttemptStatus" ADD VALUE 'PENDING_REVIEW';
ALTER TYPE "AttemptStatus" ADD VALUE 'GRADED';

-- AlterTable: campos de auditoría de la corrección manual
ALTER TABLE "mod_assessments_attempt"
  ADD COLUMN "graded_at" TIMESTAMP(3),
  ADD COLUMN "graded_by_id" UUID;

-- AlterTable: feedback por respuesta (lo deja el formador al corregir)
ALTER TABLE "mod_assessments_answer"
  ADD COLUMN "graded_feedback" TEXT;
