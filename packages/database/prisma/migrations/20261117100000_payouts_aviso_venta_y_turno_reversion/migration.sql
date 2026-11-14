-- mod.payouts — dos columnas que hacen falta tras el ensayo general de Cloud.
--
-- 1. `mod_payouts_sale.creator_notified_at`: cuándo se avisó a quien
--    administra el aula de esta venta (correo + campana). Es el sello que hace
--    el aviso idempotente: quien lo envía primero lo reclama con
--    `UPDATE … WHERE creator_notified_at IS NULL`, y una reentrega del webhook,
--    el barrido o el conciliador ya no vuelven a avisar.
--    Las ventas que YA existen se marcan como avisadas (con su fecha de
--    creación): el aviso nace para las ventas nuevas y no debe salir de golpe
--    un correo por cada venta antigua al desplegar.
--
-- 2. `mod_payouts_refund.reversal_lease_until`: turno para revertir la
--    transferencia de un reembolso. El botón «Reembolsar» y los webhooks del
--    mismo reembolso (`charge.refunded`, `refund.created`…) anotaban a la vez y
--    los dos pedían la reversión a Stripe con la misma clave de idempotencia:
--    el segundo chocaba («another in-progress request») y dejaba un error
--    grave en el log. Ahora solo pide la reversión quien tiene el turno; los
--    demás lo ven y lo dejan estar. Nace NULL (nadie lo tiene).
--
-- Solo AÑADE columnas nullable. RLS: las políticas de las dos tablas son por
-- fila (`tenant_id`) y cubren las columnas nuevas; los GRANT son por tabla.

ALTER TABLE "mod_payouts_sale" ADD COLUMN "creator_notified_at" TIMESTAMP(3);
UPDATE "mod_payouts_sale" SET "creator_notified_at" = "created_at" WHERE "creator_notified_at" IS NULL;
CREATE INDEX "mod_payouts_sale_creator_notified_at_idx" ON "mod_payouts_sale" ("creator_notified_at");

ALTER TABLE "mod_payouts_refund" ADD COLUMN "reversal_lease_until" TIMESTAMP(3);
