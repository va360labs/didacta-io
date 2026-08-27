-- LMS-123 — Acceso de seguimiento Fundae (perfil de inspección).
--
-- La instrucción de seguimiento dice que el seguimiento se realiza accediendo al
-- curso con las claves comunicadas al inicio de la acción. No había forma limpia
-- de prepararlas: el rol `auditor` abre el registro de auditoría de toda la
-- academia pero no deja recorrer el curso ni consultar el progreso, así que lo
-- único que quedaba era entregar una cuenta de administración —que escribe,
-- borra y ve el resto de las acciones—.
--
-- `INSPECTION` es una fuente de matrícula nueva porque el contenido del curso se
-- gatea por matrícula viva y no por rol: el inspector necesita una de verdad
-- para poder recorrer el itinerario. Marcarla aparte es justo lo que permite que
-- `mod.fundae` la excluya de los listados nominales, del XML y de los CSV, para
-- que quien viene a inspeccionar no aparezca como participante de la acción.

-- AlterEnum
ALTER TYPE "EnrollmentSource" ADD VALUE 'INSPECTION';

-- CreateTable
CREATE TABLE "mod_fundae_inspector_access" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "notas" TEXT,

    CONSTRAINT "mod_fundae_inspector_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mod_fundae_inspector_access_group_user_key" ON "mod_fundae_inspector_access"("tenant_id", "group_id", "user_id");

-- CreateIndex
CREATE INDEX "mod_fundae_inspector_access_user_idx" ON "mod_fundae_inspector_access"("tenant_id", "user_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "mod_fundae_inspector_access" ADD CONSTRAINT "mod_fundae_inspector_access_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "mod_fundae_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
