-- LMS-82: Matriculación nominal de alumnos en grupo bonificable Fundae.
-- Tabla de unión entre `mod_fundae_group` y `app_user` con snapshot de NIF
-- y estado ENROLLED/REMOVED para trazabilidad histórica (Fundae exige el
-- listado completo de matriculaciones, incluyendo bajas).

CREATE TABLE "mod_fundae_group_participant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "nif_alumno" TEXT,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ENROLLED',
    "notas" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_fundae_group_participant_pkey" PRIMARY KEY ("id")
);

-- UNIQUE — un alumno solo puede tener una matrícula activa por grupo (las
-- soft-deleted con status REMOVED quedan en la fila para histórico, así que
-- también colisionan; si quisiéramos re-enroll, se hace UPDATE no INSERT).
CREATE UNIQUE INDEX "mod_fundae_group_participant_group_user_key"
    ON "mod_fundae_group_participant" ("tenant_id", "group_id", "user_id");

CREATE INDEX "mod_fundae_group_participant_group_status_idx"
    ON "mod_fundae_group_participant" ("tenant_id", "group_id", "status");

CREATE INDEX "mod_fundae_group_participant_company_status_idx"
    ON "mod_fundae_group_participant" ("tenant_id", "company_id", "status");

CREATE INDEX "mod_fundae_group_participant_tenant_user_idx"
    ON "mod_fundae_group_participant" ("tenant_id", "user_id");

-- FK física hacia el grupo: si el grupo se borra duro (tooling de soporte),
-- arrastra los participantes. La FK al user es lógica (regla del módulo).
ALTER TABLE "mod_fundae_group_participant"
    ADD CONSTRAINT "mod_fundae_group_participant_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "mod_fundae_group"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
