-- Última vez que una persona usó el aula con su sesión (`user.last_seen_at`).
--
-- Solo AÑADE una columna que admite nulos, sin valor por defecto: en Postgres
-- es instantáneo y no reescribe la tabla. Nadie la lee como obligatoria: donde
-- está vacía se sigue mirando `last_login_at`, que es lo que se miraba hasta
-- ahora. La sella la API al entrar y al renovar el token (como mucho una vez
-- cada 15 minutos por persona).
--
-- Hace falta porque `last_login_at` solo cambia al poner la contraseña: quien
-- deja la sesión abierta y entra a diario aparecía como «no entra desde hace
-- un mes», y los mensajes de recuperación y el panel de miembros en riesgo le
-- habrían escrito por error.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "last_seen_at" TIMESTAMP(3);
