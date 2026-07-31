-- Defaults whitelabel: un producto genérico no puede asumir la operación del
-- cliente original.
--
-- referrals.require_active_membership: default true → false. No toda academia
-- vende membresías; quien sí, lo activa en su config. Las filas existentes
-- conservan su valor (solo afecta a configs nuevas).
ALTER TABLE "mod_referrals_config"
  ALTER COLUMN "require_active_membership" SET DEFAULT false;
