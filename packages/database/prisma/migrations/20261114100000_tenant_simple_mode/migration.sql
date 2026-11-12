-- Modo sencillo por aula (Didacta Cloud).
--
-- Toda fila existente queda en `false`: las aulas que ya existían y cualquier
-- instalación propia siguen exactamente igual que antes. Solo nacen en `true`
-- las aulas que crea el plano de control del SaaS (credencial de provisioning).
--
-- `ADD COLUMN ... NOT NULL DEFAULT` es solo de catálogo en Postgres >= 11: no
-- reescribe la tabla.
ALTER TABLE "tenant" ADD COLUMN "simple_mode" BOOLEAN NOT NULL DEFAULT false;
