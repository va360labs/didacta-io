-- Migration: 20260513000001_add_mod_secret
-- Sprint 4 / SE-002 — ctx.secrets store.
--
-- Tabla para los secretos cifrados que los módulos third-party persisten via
-- `ctx.secrets.set(...)`. El value se cifra con AES-256-GCM (`SecretCipherService`,
-- ya existente) usando la key resuelta por `loadCipherKey()` (env → file →
-- file-new → ephemeral, sin fricción al primer install).
--
-- Scoping triple: cada secret pertenece a `(tenant_id, module_id, secret_key)`.
-- El UNIQUE INDEX impide colisiones del mismo módulo en el mismo tenant; un
-- `set()` con key repetida actualiza (no inserta). Cross-tenant y cross-module
-- son imposibles porque `ScopedSecretsApi` congela `tenant_id` y `module_id`
-- en la closure, no los toma del módulo.
--
-- `expires_at` opcional: secrets job-scoped (WP appPassword del migrator-learndash)
-- se setean con expiresAt = now + retentionDays. `get()` y `list()` filtran
-- expired en la query (`AND (expires_at IS NULL OR expires_at > NOW())`).
-- Un GC periódico (a definir en Sprint 5 o cuando aparezca el caso) borra
-- los rows físicamente para que `maxKeys` no se llene de basura caducada.
--
-- `module_id` es el slug (VARCHAR(60)) del manifest, NO FK a installed_module.
-- Razón: si el admin desinstala + reinstala el mismo módulo, queremos que los
-- secretos sobrevivan (caso típico de upgrade fallido o rollback). Si el módulo
-- cambia de nombre, eso es una migración manual aparte (raro, no automatizamos).

CREATE TABLE "mod_secret" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"          UUID         NOT NULL,
  "module_id"          VARCHAR(60)  NOT NULL,
  "secret_key"         VARCHAR(128) NOT NULL,
  "ciphertext"         BYTEA        NOT NULL,
  "iv"                 BYTEA        NOT NULL,
  "tag"                BYTEA        NOT NULL,
  "approx_value_bytes" INTEGER      NOT NULL,
  "expires_at"         TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "mod_secret_pkey" PRIMARY KEY ("id")
);

-- Unique compuesto: enforce idempotencia per (tenant, módulo, key).
CREATE UNIQUE INDEX "mod_secret_unique"
  ON "mod_secret" ("tenant_id", "module_id", "secret_key");

-- Index para el GC de expirados (futuro). NULL queda fuera porque BTREE
-- ignora NULL en igualdades / rangos por default.
CREATE INDEX "mod_secret_expires_at_idx"
  ON "mod_secret" ("expires_at");

-- Index para list() del módulo: WHERE tenant_id=$1 AND module_id=$2.
CREATE INDEX "mod_secret_tenant_id_module_id_idx"
  ON "mod_secret" ("tenant_id", "module_id");
