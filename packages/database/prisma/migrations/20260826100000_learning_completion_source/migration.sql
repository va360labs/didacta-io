-- LMS-121 — Origen de la finalización de una lección.
--
-- Hasta ahora `mod_learning_progress.completed` era un booleano sin procedencia:
-- valía lo mismo el cierre que dispara el motor de evaluaciones al aprobar un
-- cuestionario que el `completed:true` que cualquier alumno matriculado podía
-- enviar a `POST /learning/progress` recorriendo los ids de las lecciones. Como
-- el porcentaje de progreso (y, colgadas de él, las horas que se exportan a
-- Fundae) se calcula contando esas filas, no había forma de distinguir la
-- actividad real de la autodeclarada — ni de demostrarlo ante una inspección.
--
-- La columna es NULLABLE a propósito: las filas anteriores a esta migración se
-- cerraron sin registrar su procedencia, y rellenarlas con 'SELF' sería fabricar
-- una evidencia que nadie tomó. NULL significa exactamente lo que pasó — no se
-- sabe — y el exportador Fundae las cuenta como no verificadas.

-- CreateEnum
CREATE TYPE "LessonCompletionSource" AS ENUM ('SELF', 'TIME', 'ASSESSMENT', 'SCORM', 'INSTRUCTOR');

-- AlterTable
ALTER TABLE "mod_learning_progress" ADD COLUMN     "completion_source" "LessonCompletionSource";
