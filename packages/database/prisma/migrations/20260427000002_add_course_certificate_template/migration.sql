-- HU-FOR-004: cada curso puede apuntar a una plantilla de certificado custom.
-- Si certificate_template_id es NULL, se usa la default del tenant.
-- Sin FK cross-module (es UUID lógico, validado en app layer).

ALTER TABLE "mod_courses_course"
  ADD COLUMN "certificate_template_id" UUID;

CREATE INDEX "mod_courses_course_certificate_template_id_idx"
  ON "mod_courses_course" ("certificate_template_id");
