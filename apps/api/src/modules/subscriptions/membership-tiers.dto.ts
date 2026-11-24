/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';
import { TIER_DESCRIPTION_MAX, TIER_NAME_MAX } from '@didacta/mod-subscriptions';

/**
 * DTOs zod de los NIVELES de la membresía (admin) y del cambio de nivel
 * (cuenta del alumno).
 */

const tierName = z.string().trim().min(1).max(TIER_NAME_MAX);
const tierDescription = z.string().trim().max(TIER_DESCRIPTION_MAX).nullable();
const courseIds = z.array(z.string().uuid()).max(500);

export const createTierSchema = z
  .object({
    name: tierName,
    description: tierDescription.optional(),
    /** Nivel gratis: sin planes ni cobro; se entra con el registro gratis. */
    isFree: z.boolean().optional(),
    /** Todos los cursos (también los que se publiquen después). */
    allCourses: z.boolean().optional(),
    /** Cursos del nivel (si no son todos). */
    courseIds: courseIds.optional(),
  })
  .strict();
export type CreateTierDto = z.infer<typeof createTierSchema>;

export const updateTierSchema = z
  .object({
    name: tierName.optional(),
    description: tierDescription.optional(),
    /** Apagado: no se vende ni se ofrece; quien ya lo paga conserva su acceso. */
    active: z.boolean().optional(),
    courseIds: courseIds.optional(),
    /**
     * Solo el nivel gratis: «Revisar a mano cada alta gratis». Apagado (lo
     * normal), quien verifica su correo con código entra al momento.
     */
    manualReview: z.boolean().optional(),
  })
  .strict();
export type UpdateTierDto = z.infer<typeof updateTierSchema>;

export const reorderTiersSchema = z
  .object({
    tierIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();
export type ReorderTiersDto = z.infer<typeof reorderTiersSchema>;

export const changePlanSchema = z
  .object({
    planId: z.string().uuid(),
  })
  .strict();
export type ChangePlanDto = z.infer<typeof changePlanSchema>;
