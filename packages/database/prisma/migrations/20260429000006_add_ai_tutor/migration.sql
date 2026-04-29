-- LMS-90: módulo AI Tutor con RAG sobre contenido del curso (Fase 1.C).
--
-- Requiere extensión pgvector. La extensión queda en el search_path
-- public por defecto. Si en algún tenant se restringe schema, ajustar
-- la migración manualmente.

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── chunks indexados ──────────────────────────────────────────────────

CREATE TABLE "mod_ai_tutor_chunk" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "lesson_id" UUID,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "tokens_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_ai_tutor_chunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mod_ai_tutor_chunk_tenant_course_ordinal_idx"
    ON "mod_ai_tutor_chunk" ("tenant_id", "course_id", "ordinal");

CREATE INDEX "mod_ai_tutor_chunk_tenant_course_lesson_idx"
    ON "mod_ai_tutor_chunk" ("tenant_id", "course_id", "lesson_id");

-- IVFFlat index para cosine similarity. Lists=100 es razonable para
-- volúmenes hasta ~1M chunks por curso. Reajustar si crecemos mucho.
-- Operador <=> es el de cosine distance (1 - cos similarity) en pgvector.
CREATE INDEX "mod_ai_tutor_chunk_embedding_cosine_idx"
    ON "mod_ai_tutor_chunk"
    USING ivfflat ("embedding" vector_cosine_ops)
    WITH (lists = 100);

-- ─── conversaciones ────────────────────────────────────────────────────

CREATE TABLE "mod_ai_tutor_conversation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_ai_tutor_conversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mod_ai_tutor_conversation_tenant_user_course_idx"
    ON "mod_ai_tutor_conversation" ("tenant_id", "user_id", "course_id");

-- ─── mensajes del chat ─────────────────────────────────────────────────

CREATE TABLE "mod_ai_tutor_message" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "tokens_input" INTEGER NOT NULL DEFAULT 0,
    "tokens_output" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mod_ai_tutor_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mod_ai_tutor_message_conv_created_idx"
    ON "mod_ai_tutor_message" ("conversation_id", "created_at");

ALTER TABLE "mod_ai_tutor_message"
    ADD CONSTRAINT "mod_ai_tutor_message_conv_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "mod_ai_tutor_conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── token usage agregado por día ──────────────────────────────────────

CREATE TABLE "mod_ai_tutor_token_usage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "day" DATE NOT NULL,
    "tokens_input" INTEGER NOT NULL DEFAULT 0,
    "tokens_output" INTEGER NOT NULL DEFAULT 0,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_ai_tutor_token_usage_pkey" PRIMARY KEY ("id")
);

-- UNIQUE compuesto. Usamos COALESCE para tratar NULL como un valor
-- "agregado tenant". Postgres no soporta UNIQUE con NULL como igualdad,
-- así que creamos un índice único con expresión.
CREATE UNIQUE INDEX "mod_ai_tutor_token_usage_tenant_user_day_key"
    ON "mod_ai_tutor_token_usage" ("tenant_id", COALESCE("user_id", '00000000-0000-0000-0000-000000000000'::uuid), "day");

CREATE INDEX "mod_ai_tutor_token_usage_tenant_day_idx"
    ON "mod_ai_tutor_token_usage" ("tenant_id", "day");
