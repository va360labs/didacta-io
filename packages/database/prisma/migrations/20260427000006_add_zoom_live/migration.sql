-- mod.zoom-live: sesiones síncronas Zoom asociadas opcionalmente a un curso.
CREATE TABLE "mod_zoom_session" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "course_id" UUID,
  "topic" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
  "start_time" TIMESTAMP(3) NOT NULL,
  "duration_minutes" INTEGER NOT NULL,
  "timezone" TEXT NOT NULL,
  "host_email" TEXT NOT NULL,
  "zoom_meeting_id" TEXT,
  "join_url" TEXT,
  "start_url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mod_zoom_session_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mod_zoom_session_tenant_idx" ON "mod_zoom_session"("tenant_id", "start_time" DESC);
CREATE INDEX "mod_zoom_session_course_idx" ON "mod_zoom_session"("course_id") WHERE "course_id" IS NOT NULL;
