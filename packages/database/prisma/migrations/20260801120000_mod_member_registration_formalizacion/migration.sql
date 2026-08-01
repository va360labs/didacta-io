-- mod.member-registration F3 — formalización del módulo (migración coordinada).
--
-- 1) D13 F2 (pendiente desde F1): rename del enum al nombre canónico de Prisma
--    del módulo. Solo cambia el nombre del TIPO en Postgres; los valores
--    (APPROVE/REJECT) y los datos de mod_member_registration_decision_token no
--    se tocan.
ALTER TYPE "MemberDecisionAction" RENAME TO "MemberRegistrationDecisionAction";

-- 2) F3: las claves de plantillas de email del flujo pasan del namespace legacy
--    `inscripcion.*` al del módulo `member_registration.*` (las plantillas las
--    registra ahora el módulo en el catálogo). Migra los overrides per-tenant
--    existentes en notification_template; sin riesgo de colisión con la unique
--    (tenant_id, key, channel, locale) porque las claves nuevas no existían.
UPDATE "notification_template" SET "key" = 'member_registration.otp_code' WHERE "key" = 'inscripcion.otp_code';
UPDATE "notification_template" SET "key" = 'member_registration.approval_request' WHERE "key" = 'inscripcion.approval_request';
UPDATE "notification_template" SET "key" = 'member_registration.welcome_approved' WHERE "key" = 'inscripcion.welcome_approved';
UPDATE "notification_template" SET "key" = 'member_registration.rejection' WHERE "key" = 'inscripcion.rejection';
