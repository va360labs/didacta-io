-- Dirección de la academia: el administrador cambia él solo el subdominio de
-- su aula (`<x>.<sufijo>` → `<y>.<sufijo>`) desde Ajustes.
--
-- Solo AÑADE una columna con valor por defecto: `false` en todas las filas que
-- ya existen, así que ningún dominio cambia de comportamiento al actualizar.
-- Solo la pone a `true` el propio cambio de dirección, en la dirección que el
-- aula deja de usar: sigue resolviendo el aula y sus páginas redirigen (308) a
-- la nueva. Ver `TenantDomain.redirectToPrimary`.

-- AlterTable
ALTER TABLE "tenant_domain" ADD COLUMN "redirect_to_primary" BOOLEAN NOT NULL DEFAULT false;
