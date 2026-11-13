-- Referidos: pedir el cobro EN DINERO con los datos para pagar.
--
-- 1) Datos del alumno para cobrar (nombre completo, NIF/NIE o identificador
--    fiscal del país, IBAN): un JSON cifrado con AES-256-GCM, como el resto de
--    secretos de la plataforma. La rotación de la clave lo recifra
--    (`apps/api/src/maintenance/rotate-cipher-key.ts`).
-- 2) La liquidación en dinero nace REQUESTED (la pide el alumno) y pasa a
--    DONE cuando el creador la marca pagada (`paid_at`). A lo sumo UNA pedida
--    por alumno y aula.
-- La tabla de miembros gana un `id` de fila: la rotación de la clave recifra
-- por `id` (tabla de un día, pocas filas: el DEFAULT volátil la reescribe).
ALTER TABLE "mod_referrals_member" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX "mod_referrals_member_id_key" ON "mod_referrals_member"("id");
ALTER TABLE "mod_referrals_member" ADD COLUMN "payee_cipher" BYTEA;
ALTER TABLE "mod_referrals_member" ADD COLUMN "payee_iv" BYTEA;
ALTER TABLE "mod_referrals_member" ADD COLUMN "payee_tag" BYTEA;
ALTER TABLE "mod_referrals_member" ADD COLUMN "payee_updated_at" TIMESTAMP(3);

ALTER TABLE "mod_referrals_payout" ADD COLUMN "paid_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "mod_referrals_payout_one_requested_cash"
  ON "mod_referrals_payout" ("tenant_id", "referrer_user_id")
  WHERE "method" = 'CASH' AND "status" = 'REQUESTED';
