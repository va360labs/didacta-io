-- =============================================================================
-- HU-USR-001: campos de perfil de usuario.
-- =============================================================================

ALTER TABLE "user"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN "avatar_url" TEXT;
