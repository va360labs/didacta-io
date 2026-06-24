-- Inscripción externa por API + URL de compra externa por curso.

-- 1. URL de una página de ventas externa donde se compra el curso. Si está
--    set, la ficha del curso muestra el CTA "Comprar" que redirige a esta URL.
ALTER TABLE "mod_courses_course" ADD COLUMN "external_purchase_url" VARCHAR(2048);

-- 2. Flag de contraseña temporal: el usuario creado por `POST /api/v1/inscribe`
--    (compra externa) recibe una contraseña temporal por email y es forzado a
--    cambiarla tras el primer login mientras este flag siga en true.
ALTER TABLE "user" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;

-- 3. Nuevo origen de matriculación: inscripción creada por un sistema externo
--    vía API key (`POST /api/v1/inscribe`).
ALTER TYPE "EnrollmentSource" ADD VALUE 'API';
