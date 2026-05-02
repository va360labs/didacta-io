-- MIG-031: Marketplace — alineación con esquema de firma KMS de Didacta.
-- ADR-009 refactor:
--   * Renombra el valor del enum `InstalledModuleVendor` 'VA360' → 'DIDACTA'.
--     El producto es Didacta (VA360 LABS S.L. es la empresa, no el vendor).
--   * Renombra columna `signature_b64` → `manifest_jwt`. El paquete ahora
--     trae un JWT compact ES256 firmado por AWS KMS en lugar de un manifest
--     + firma RSA-PSS separados. Mismo patrón que el license-sdk.
--
-- Esta migración asume que `installed_module` aún no tiene rows en
-- producción (la tabla se introdujo en MIG-029 de esta misma sesión y los
-- 6 PRs del rollout ADR-009 acaban de mergear). Si en algún deploy hay
-- rows con `vendor='VA360'`, el rename los reescribe transparentemente.

-- 1. Rename del enum value. Postgres soporta ALTER TYPE ... RENAME VALUE
-- desde la 10. La cláusula no requiere CASCADE porque actualiza la
-- definición del tipo y los rows existentes mantienen su discriminator
-- bajo el nombre nuevo.
ALTER TYPE "InstalledModuleVendor" RENAME VALUE 'VA360' TO 'DIDACTA';

-- 2. Rename de la columna. RENAME COLUMN preserva el contenido — útil si
-- algún deploy ya tenía paquetes subidos, aunque el formato del valor
-- cambia (antes: base64 RSA-PSS; ahora: JWT compact). Cualquier row
-- pre-existente fallará al re-verificar y debe reinstalarse desde un
-- paquete generado con el nuevo flujo `scripts/marketplace/sign-package.ts`.
ALTER TABLE "installed_module" RENAME COLUMN "signature_b64" TO "manifest_jwt";
