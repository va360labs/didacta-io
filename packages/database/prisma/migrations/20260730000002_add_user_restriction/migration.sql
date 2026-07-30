-- Sanciones de moderación: el usuario sigue entrando y leyendo, pero no puede
-- aportar contenido en las áreas sancionadas.
--
-- Deliberadamente distinta de user.status = 'SUSPENDED', que corta el login
-- entero. Aquí el caso de uso es el contrario: alguien que paga y consume el
-- curso pero hace spam en el feed conserva el acceso a lo que compró.
--
-- Vive en el core y no en un módulo porque una sanción cruza comunidad,
-- mensajería, subidas y tutor IA a la vez. El enforcement es central
-- (RestrictionInterceptor), así que ningún módulo conoce esta tabla.
--
-- tenant_id NOT NULL a propósito: la política RLS genérica (rls.sql) cubre
-- automáticamente toda tabla de public con columna tenant_id, así que esta
-- queda aislada por tenant sin tocar el script.
--
-- Nota: el flujo real de despliegue es `prisma db push`. Este fichero deja el
-- histórico coherente para quien reconstruya la base desde cero.

CREATE TABLE IF NOT EXISTS "user_restriction" (
    "id"            UUID         NOT NULL,
    "tenant_id"     UUID         NOT NULL,
    "user_id"       UUID         NOT NULL,
    -- 'community' | 'messaging' | 'uploads' | 'ai', o el comodín 'all'.
    -- Se guarda 'all' literal (y no la lista expandida) para que un baneo
    -- total cubra también las áreas que se añadan más adelante.
    "scopes"        TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Obligatorio: se le muestra al sancionado en el 403. Un error mudo
    -- genera un ticket de soporte; uno con motivo, no.
    "reason"        VARCHAR(500) NOT NULL,
    -- NULL = permanente. La expiración es perezosa (no hay cron): la consulta
    -- filtra por fecha, así que una sanción caducada deja de aplicar sola.
    "expires_at"    TIMESTAMP(3),
    "created_by_id" UUID         NOT NULL,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Levantar una sanción NO borra la fila: la sella. El histórico completo
    -- es lo que hace útil el expediente del usuario.
    "lifted_at"     TIMESTAMP(3),
    "lifted_by_id"  UUID,
    "lift_reason"   VARCHAR(500),

    CONSTRAINT "user_restriction_pkey" PRIMARY KEY ("id")
);

-- El interceptor pega a este índice en cada petición mutante.
CREATE INDEX IF NOT EXISTS "user_restriction_tenant_user_active_idx"
    ON "user_restriction"("tenant_id", "user_id", "lifted_at");

CREATE INDEX IF NOT EXISTS "user_restriction_tenant_created_idx"
    ON "user_restriction"("tenant_id", "created_at");

-- FK solo sobre user_id (es core, igual que session y api_key). created_by_id
-- y lifted_by_id quedan como referencias débiles, igual que audit_log.actor_id:
-- borrar a un admin no debe llevarse por delante el histórico de moderación.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_restriction_user_id_fkey'
    ) THEN
        ALTER TABLE "user_restriction"
            ADD CONSTRAINT "user_restriction_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "user"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
