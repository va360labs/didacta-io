-- mod.soporte — «Ayuda y sugerencias»: tickets de los miembros para el equipo.
--
-- Solo AÑADE: dos enumerados y la tabla `mod_soporte_ticket` con sus dos
-- índices. No altera ninguna tabla existente ni escribe una sola fila: un aula
-- que actualice no ve nada distinto hasta que alguien abre su primer ticket.
--
-- Lleva `tenant_id`, así que `rls.sql` le aplica sola la política de
-- aislamiento por aula al reaplicarse tras la migración. Sin claves foráneas:
-- el autor es un id lógico de `user` (ADR-016/039).
--
-- El esquema es el mismo que el de Community (VA360,
-- `20261123120000_add_soporte`): un arreglo del módulo pasa de un repo al
-- otro sin traducir nada.

-- CreateEnum
CREATE TYPE "ModSoporteTipo" AS ENUM ('FALLO', 'PROBLEMA', 'MEJORA');

-- CreateEnum
CREATE TYPE "ModSoporteEstado" AS ENUM ('NUEVO', 'EN_CURSO', 'RESUELTO', 'DESCARTADO');

-- CreateTable
CREATE TABLE "mod_soporte_ticket" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "autor_id" UUID NOT NULL,
    "autor_nombre" TEXT NOT NULL,
    "tipo" "ModSoporteTipo" NOT NULL,
    "texto" TEXT NOT NULL,
    "estado" "ModSoporteEstado" NOT NULL DEFAULT 'NUEVO',
    "contexto_url" TEXT,
    "contexto_user_agent" TEXT,
    "contexto_viewport" TEXT,
    "contexto_at" TIMESTAMP(3),
    "captura_key" TEXT,
    "captura_content_type" TEXT,
    "captura_nombre" TEXT,
    "captura_size" INTEGER,
    "nota_interna" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_soporte_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mod_soporte_ticket_tenant_id_estado_created_at_idx" ON "mod_soporte_ticket"("tenant_id", "estado", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mod_soporte_ticket_tenant_id_autor_id_created_at_idx" ON "mod_soporte_ticket"("tenant_id", "autor_id", "created_at" DESC);
