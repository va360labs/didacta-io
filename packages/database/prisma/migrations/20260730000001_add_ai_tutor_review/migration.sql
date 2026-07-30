-- Revisión humana del tutor IA: ver qué se le pregunta, juzgar la respuesta y,
-- si está mal, dejar escrita la correcta para que el tutor la use.
--
-- La corrección NO va a mod_ai_tutor_chunk: la reindexación de un curso hace
-- DELETE + INSERT de todos sus chunks, así que cualquier corrección guardada
-- ahí desaparecería en el siguiente `courses.lesson.updated`. Tabla propia.
--
-- tenant_id NOT NULL a propósito: la política RLS genérica (rls.sql) cubre
-- automáticamente toda tabla de public con columna tenant_id.
--
-- Nota: el flujo real de despliegue es `prisma db push`. Este fichero deja el
-- histórico coherente para quien reconstruya la base desde cero.

-- ── Revisión sobre el mensaje del tutor ─────────────────────────────────────

ALTER TABLE "mod_ai_tutor_message"
    ADD COLUMN IF NOT EXISTS "question_embedding" vector(1536),
    ADD COLUMN IF NOT EXISTS "review_status" TEXT NOT NULL DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS "reviewed_by_id" UUID,
    ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "review_note" TEXT;

CREATE INDEX IF NOT EXISTS "mod_ai_tutor_message_tenant_role_created_idx"
    ON "mod_ai_tutor_message"("tenant_id", "role", "created_at");
CREATE INDEX IF NOT EXISTS "mod_ai_tutor_message_tenant_review_idx"
    ON "mod_ai_tutor_message"("tenant_id", "review_status", "created_at");

-- ── Respuestas validadas por el equipo ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS "mod_ai_tutor_correction" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "course_id" UUID,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "source_message_id" UUID,
    "author_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "times_used" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mod_ai_tutor_correction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "mod_ai_tutor_correction_tenant_course_idx"
    ON "mod_ai_tutor_correction"("tenant_id", "course_id");
CREATE INDEX IF NOT EXISTS "mod_ai_tutor_correction_tenant_active_idx"
    ON "mod_ai_tutor_correction"("tenant_id", "active");
