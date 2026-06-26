-- Migration: 20260625000002_add_access_groups
-- Fase 2 — mod.access-groups (grupos de acceso configurables)
--
-- Grupos de entitlement: qué SET de cursos puede ver un miembro. Tres kinds:
--   ALL_COURSES (VA360.pro = todos los cursos), COURSE, MULTI_COURSE.
-- Sin FKs cross-módulo (user_id / course_id son IDs lógicos, no FK a user/curso).
-- Tablas con tenant_id → heredan RLS (tenant_isolation) vía rls.sql.

-- 0. Nuevo origen de matriculación: enrollment creado por un grupo de acceso.
--    Permite la revocación segura por refcount (unenrollFromGroup solo toca
--    enrollments source=GROUP; nunca PURCHASE/SUBSCRIPTION/API).
ALTER TYPE "EnrollmentSource" ADD VALUE 'GROUP';

-- 1. Enum del tipo de grupo.
CREATE TYPE "AccessGroupKind" AS ENUM ('ALL_COURSES', 'COURSE', 'MULTI_COURSE');

-- ── mod_access_groups_group ─────────────────────────────────────────────────

CREATE TABLE "mod_access_groups_group" (
  "id"                      UUID              NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"               UUID              NOT NULL,
  "slug"                    VARCHAR(120)      NOT NULL,
  "name"                    TEXT              NOT NULL,
  "description"             TEXT,
  "kind"                    "AccessGroupKind" NOT NULL,
  "is_default_for_approval" BOOLEAN           NOT NULL DEFAULT false,
  "auto_grant_new_courses"  BOOLEAN           NOT NULL DEFAULT true,
  "member_count"            INTEGER           NOT NULL DEFAULT 0,
  "created_at"              TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3)      NOT NULL,
  "deleted_at"              TIMESTAMP(3),

  CONSTRAINT "mod_access_groups_group_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_access_groups_group_tenant_slug_key"
  ON "mod_access_groups_group" ("tenant_id", "slug");

CREATE INDEX "mod_access_groups_group_tenant_deleted_idx"
  ON "mod_access_groups_group" ("tenant_id", "deleted_at");

-- ── mod_access_groups_group_course (vacío para ALL_COURSES) ──────────────────

CREATE TABLE "mod_access_groups_group_course" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "group_id"   UUID         NOT NULL,
  "tenant_id"  UUID         NOT NULL,
  "course_id"  UUID         NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mod_access_groups_group_course_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mod_access_groups_group_course_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "mod_access_groups_group" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "mod_access_groups_group_course_unique"
  ON "mod_access_groups_group_course" ("group_id", "course_id");

CREATE INDEX "mod_access_groups_group_course_tenant_course_idx"
  ON "mod_access_groups_group_course" ("tenant_id", "course_id");

-- ── mod_access_groups_group_member ───────────────────────────────────────────

CREATE TABLE "mod_access_groups_group_member" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "group_id"   UUID         NOT NULL,
  "tenant_id"  UUID         NOT NULL,
  "user_id"    UUID         NOT NULL,
  "status"     VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "mod_access_groups_group_member_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mod_access_groups_group_member_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "mod_access_groups_group" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "mod_access_groups_member_unique"
  ON "mod_access_groups_group_member" ("group_id", "user_id");

CREATE INDEX "mod_access_groups_group_member_tenant_user_idx"
  ON "mod_access_groups_group_member" ("tenant_id", "user_id");

-- ── mod_access_groups_grant (provenance / reference-counting) ────────────────

CREATE TABLE "mod_access_groups_grant" (
  "id"                     UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"              UUID         NOT NULL,
  "group_id"               UUID         NOT NULL,
  "user_id"                UUID         NOT NULL,
  "course_id"              UUID         NOT NULL,
  "enrollment_external_id" TEXT,
  "granted_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at"             TIMESTAMP(3),

  CONSTRAINT "mod_access_groups_grant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_access_groups_grant_unique"
  ON "mod_access_groups_grant" ("tenant_id", "group_id", "user_id", "course_id");

CREATE INDEX "mod_access_groups_grant_tenant_user_course_idx"
  ON "mod_access_groups_grant" ("tenant_id", "user_id", "course_id");
