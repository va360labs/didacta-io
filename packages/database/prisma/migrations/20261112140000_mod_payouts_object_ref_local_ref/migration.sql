-- Los webhooks heredados (claves propias de cada aula) rechazan un evento que
-- nombre una orden cobrada por la plataforma. Esa comprobación busca la sesión
-- de checkout registrada por su orden local: sin índice sería un barrido de la
-- tabla en cada evento.

-- CreateIndex
CREATE INDEX "mod_payouts_object_ref_kind_local_ref_idx" ON "mod_payouts_object_ref"("kind", "local_ref");
