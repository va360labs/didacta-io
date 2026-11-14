-- mod.subscriptions — el titular de /join ya no nace en español.
--
-- La columna ponía «Hazte miembro» por defecto a TODAS las aulas, también a
-- las que son en inglés o en portugués. Ahora nace vacía: el titular por
-- defecto no se guarda, lo pone la web desde su catálogo en el idioma del aula.
--
-- Solo cambia el DEFAULT (catálogo, no reescribe la tabla) y no toca ninguna
-- fila: las que ya guardaron «Hazte miembro» se leen igual como «sin titular
-- propio» (`customMembershipHeadline`), así que no hace falta migrarlas.

ALTER TABLE "mod_subscriptions_membership_config"
  ALTER COLUMN "headline" SET DEFAULT '';
