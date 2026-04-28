-- IAM: campo de documento de identidad (DNI/NIE) por usuario.
-- Requerido por Fundae v0.3 para emitir el XML de subvenciones con
-- los participantes correctamente identificados. Nullable porque no
-- todos los tenants son españoles ni todos los usuarios necesitan
-- declarar DNI (depende del rol y la jurisdicción).
ALTER TABLE "user"
  ADD COLUMN "document_id" VARCHAR(20);

-- Unicidad por tenant: dos usuarios del mismo tenant no pueden compartir
-- DNI. Permite NULLs múltiples (Postgres lo hace por defecto en UNIQUE).
CREATE UNIQUE INDEX "user_tenant_document_id_key"
  ON "user"("tenant_id", "document_id")
  WHERE "document_id" IS NOT NULL;
