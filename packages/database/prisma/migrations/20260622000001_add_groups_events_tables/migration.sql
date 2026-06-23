-- Migration: 20260622000001_add_groups_events_tables
-- UC-011 (mod.groups) + UC-013 (mod.events) — alpha.89
--
-- Tablas mínimas para grupos de comunidad y eventos en directo.
-- Sin FKs cross-módulo (userId es ID lógico, no FK a user).

-- ── mod_group ──────────────────────────────────────────────────────────────

CREATE TABLE "mod_group" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    UUID         NOT NULL,
  "name"         TEXT         NOT NULL,
  "slug"         VARCHAR(120) NOT NULL,
  "description"  TEXT,
  "member_count" INTEGER      NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  "deleted_at"   TIMESTAMP(3),

  CONSTRAINT "mod_group_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_group_tenant_slug_key"
  ON "mod_group" ("tenant_id", "slug");

CREATE INDEX "mod_group_tenant_deleted_idx"
  ON "mod_group" ("tenant_id", "deleted_at");

-- ── mod_group_member ───────────────────────────────────────────────────────

CREATE TABLE "mod_group_member" (
  "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "group_id"  UUID         NOT NULL,
  "tenant_id" UUID         NOT NULL,
  "user_id"   UUID         NOT NULL,
  "role"      VARCHAR(30)  NOT NULL DEFAULT 'member',
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mod_group_member_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mod_group_member_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "mod_group" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "mod_group_member_unique"
  ON "mod_group_member" ("group_id", "user_id");

CREATE INDEX "mod_group_member_tenant_user_idx"
  ON "mod_group_member" ("tenant_id", "user_id");

-- ── mod_event ──────────────────────────────────────────────────────────────

CREATE TABLE "mod_event" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"      UUID         NOT NULL,
  "title"          TEXT         NOT NULL,
  "description"    TEXT,
  "location"       TEXT,
  "start_at"       TIMESTAMP(3) NOT NULL,
  "end_at"         TIMESTAMP(3) NOT NULL,
  "capacity"       INTEGER,
  "created_by_id"  UUID,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  "deleted_at"     TIMESTAMP(3),

  CONSTRAINT "mod_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mod_event_tenant_start_deleted_idx"
  ON "mod_event" ("tenant_id", "start_at", "deleted_at");

-- ── mod_event_registration ─────────────────────────────────────────────────

CREATE TABLE "mod_event_registration" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "event_id"      UUID         NOT NULL,
  "tenant_id"     UUID         NOT NULL,
  "user_id"       UUID         NOT NULL,
  "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mod_event_registration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mod_event_registration_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "mod_event" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "mod_event_registration_unique"
  ON "mod_event_registration" ("event_id", "user_id");

CREATE INDEX "mod_event_registration_tenant_user_idx"
  ON "mod_event_registration" ("tenant_id", "user_id");
