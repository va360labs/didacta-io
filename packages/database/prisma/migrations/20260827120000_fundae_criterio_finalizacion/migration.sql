-- LMS-124 — Criterio de finalización por acción formativa.
--
-- Hasta ahora un participante quedaba APTO comparando el porcentaje de lecciones
-- que él mismo había marcado contra el umbral del grupo. La instrucción de
-- seguimiento de Fundae pide otra cosa: 75 % de las HORAS, 75 % de las
-- ACTIVIDADES de aprendizaje y 75 % de los CONTROLES periódicos.
--
-- El criterio va POR ACCIÓN FORMATIVA y arranca en `UMBRAL_PROGRESO` para todas
-- las existentes. No es tibieza: cambiar la regla de golpe reescribiría el
-- veredicto de participantes de grupos que puede que ya se hayan comunicado a
-- la Fundación, y decidir eso corresponde a quien firma la bonificación, no a
-- una migración. Una academia que quiera el criterio de la instrucción lo activa
-- acción a acción.

-- CreateEnum
CREATE TYPE "FundaeCriterioFinalizacion" AS ENUM ('UMBRAL_PROGRESO', 'INSTRUCCION_75');

-- AlterTable
ALTER TABLE "mod_fundae_action" ADD COLUMN     "criterio_finalizacion" "FundaeCriterioFinalizacion" NOT NULL DEFAULT 'UMBRAL_PROGRESO';
