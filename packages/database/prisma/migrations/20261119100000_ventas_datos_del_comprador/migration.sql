-- «Ventas» con los datos de cada venta: país del comprador y cupón.
--
-- Lo que confirma Stripe al cobrar y hasta ahora se tiraba: el país de la
-- dirección de facturación (`customer_details.address.country`) y, en un pago
-- único, el descuento de un cupón (`total_details.amount_discount`). Las cuotas
-- de una suscripción heredan el país de su alta.
--
-- Columnas nuevas y NULLABLE: no reescriben las tablas ni tocan filas. Las
-- ventas anteriores se quedan sin país («—» en la tabla y vacío en la
-- exportación): no se inventa.

ALTER TABLE "mod_billing_order"
  ADD COLUMN "customer_country" VARCHAR(2),
  ADD COLUMN "discount_amount" INTEGER;

ALTER TABLE "mod_subscriptions_subscription"
  ADD COLUMN "customer_country" VARCHAR(2);
