-- mod.courses: categorías curadas con metadata visual (color/icono).
-- mod_courses_course.category sigue siendo string libre por compat con
-- datos existentes; el admin las cura acá y el builder ofrece un select.
CREATE TABLE "mod_courses_category" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL,
  "icon" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mod_courses_category_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_courses_category_tenant_name_key"
  ON "mod_courses_category"("tenant_id", "name");

CREATE INDEX "mod_courses_category_tenant_id_idx" ON "mod_courses_category"("tenant_id");
