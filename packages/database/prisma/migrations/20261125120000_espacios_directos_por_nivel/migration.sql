-- Espacios de la comunidad y directos restringidos por nivel de membresía.
--
-- Solo AÑADE una columna a dos tablas que ya existen: la lista de grupos de
-- acceso (mod.access-groups; cada nivel de membresía es un grupo) cuyos
-- miembros ACTIVOS pueden ver el espacio o la clase. Vacía = todos los
-- miembros, que es como funciona hoy: ningún aula ve nada distinto hasta que el
-- creador elige «Solo estos niveles».
--
-- IDs lógicos, sin clave foránea a `mod_access_groups_group` (ADR-016: nada de
-- FKs entre módulos). Un grupo borrado deja de dar acceso por sí solo: nadie es
-- miembro ACTIVO de un grupo borrado, así que lo restringido sigue cerrado.
--
-- Las dos tablas ya tienen `tenant_id` y su política de RLS: no hace falta
-- tocar `rls.sql` ni `grants.sql`.

-- AlterTable
ALTER TABLE "mod_community_space" ADD COLUMN "access_group_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

-- AlterTable
ALTER TABLE "mod_zoom_live_session" ADD COLUMN "access_group_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
