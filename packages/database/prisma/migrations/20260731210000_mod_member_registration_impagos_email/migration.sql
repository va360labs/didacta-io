-- F2.3 (registro componible): impagos re-clavados a email/user_id.
-- La clave de negocio del flag pasa de telegram_id (era del gate Telegram) a
-- email, con user_id vinculado cuando se puede resolver. telegram_id queda
-- como clave LEGACY opcional para las filas históricas y los imports de
-- exportaciones de Telegram. Migración ADITIVA: no se pierde ninguna fila.

-- 1) Columnas nuevas + telegram_id pasa a opcional.
ALTER TABLE "mod_member_registration_payment_flag"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "user_id" UUID;

ALTER TABLE "mod_member_registration_payment_flag"
  ALTER COLUMN "telegram_id" DROP NOT NULL;

-- 2) Backfill best-effort: vincula cada flag legacy con el usuario de su
--    tenant que registró ese telegram_id (vía el perfil del vertical, fuente
--    de verdad D13). El unique parcial de telegram_id por tenant garantiza
--    a lo sumo un perfil por flag, y user.email es único por tenant, así que
--    el backfill no puede violar la unique nueva de (tenant_id, email).
UPDATE "mod_member_registration_payment_flag" f
SET "email" = u."email",
    "user_id" = p."user_id"
FROM "mod_member_registration_profile" p
JOIN "user" u ON u."id" = p."user_id"
WHERE p."tenant_id" = f."tenant_id"
  AND p."telegram_id" = f."telegram_id"
  AND f."telegram_id" IS NOT NULL
  AND f."email" IS NULL;

-- 3) Unique de la clave nueva (los NULL no chocan entre sí en Postgres).
CREATE UNIQUE INDEX "mod_member_registration_payment_flag_tenant_id_email_key"
  ON "mod_member_registration_payment_flag"("tenant_id", "email");
