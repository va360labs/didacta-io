-- mod.zoom-live: del prefijo corto histórico `mod_zoom_` al canónico
-- `mod_<slug>_` (= `mod_zoom_live_`), que es lo que exige el contrato de
-- módulos (module-doctor deriva el prefijo del name del manifest).
--
-- Solo RENAME: no destructivo. Las FKs, políticas RLS y grants siguen a la
-- tabla en PostgreSQL; los índices y constraints se renombran aparte porque
-- ALTER TABLE RENAME no los toca. El identificador cliente de Prisma
-- (`name:` de los @@unique, p.ej. `mod_zoom_session_registration_unique`)
-- NO cambia — solo cambia el nombre físico (`map:`).

-- Tablas
ALTER TABLE "mod_zoom_session" RENAME TO "mod_zoom_live_session";
ALTER TABLE "mod_zoom_session_registration" RENAME TO "mod_zoom_live_session_registration";
ALTER TABLE "mod_zoom_session_attendance" RENAME TO "mod_zoom_live_session_attendance";
ALTER TABLE "mod_zoom_webhook_event" RENAME TO "mod_zoom_live_webhook_event";

-- Índices (incluye PKs y uniques, que en PostgreSQL son índices)
ALTER INDEX "mod_zoom_session_pkey" RENAME TO "mod_zoom_live_session_pkey";
ALTER INDEX "mod_zoom_session_tenant_idx" RENAME TO "mod_zoom_live_session_tenant_idx";
ALTER INDEX "mod_zoom_session_course_idx" RENAME TO "mod_zoom_live_session_course_idx";
ALTER INDEX "mod_zoom_session_lesson_idx" RENAME TO "mod_zoom_live_session_lesson_idx";
ALTER INDEX "mod_zoom_session_registration_pkey" RENAME TO "mod_zoom_live_session_registration_pkey";
ALTER INDEX "mod_zoom_session_registration_unique" RENAME TO "mod_zoom_live_session_registration_unique";
ALTER INDEX "mod_zoom_session_registration_tenant_user_idx" RENAME TO "mod_zoom_live_session_registration_tenant_user_idx";
ALTER INDEX "mod_zoom_session_attendance_pkey" RENAME TO "mod_zoom_live_session_attendance_pkey";
ALTER INDEX "mod_zoom_session_attendance_unique" RENAME TO "mod_zoom_live_session_attendance_unique";
ALTER INDEX "mod_zoom_session_attendance_tenant_session_idx" RENAME TO "mod_zoom_live_session_attendance_tenant_session_idx";
ALTER INDEX "mod_zoom_session_attendance_tenant_user_idx" RENAME TO "mod_zoom_live_session_attendance_tenant_user_idx";
ALTER INDEX "mod_zoom_webhook_event_pkey" RENAME TO "mod_zoom_live_webhook_event_pkey";
ALTER INDEX "mod_zoom_webhook_event_event_id_key" RENAME TO "mod_zoom_live_webhook_event_event_id_key";
ALTER INDEX "mod_zoom_webhook_event_meeting_idx" RENAME TO "mod_zoom_live_webhook_event_meeting_idx";
ALTER INDEX "mod_zoom_webhook_event_session_idx" RENAME TO "mod_zoom_live_webhook_event_session_idx";

-- FKs intra-módulo (registration/attendance → session)
ALTER TABLE "mod_zoom_live_session_registration" RENAME CONSTRAINT "mod_zoom_session_registration_session_id_fkey" TO "mod_zoom_live_session_registration_session_id_fkey";
ALTER TABLE "mod_zoom_live_session_attendance" RENAME CONSTRAINT "mod_zoom_session_attendance_session_id_fkey" TO "mod_zoom_live_session_attendance_session_id_fkey";
