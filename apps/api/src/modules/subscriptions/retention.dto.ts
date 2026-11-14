/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { EXIT_REASONS, EXIT_REASON_TEXT_MAX, RETENTION_LIMITS } from '@didacta/mod-subscriptions';
import { z } from 'zod';

/**
 * DTOs zod de la oferta al darse de baja. Los límites salen del módulo
 * (`RETENTION_LIMITS`), que los vuelve a comprobar: el módulo no depende de su
 * llamador.
 */

/** Lo que decide el alumno en «Darme de baja». */
export const leaveSchema = z
  .object({
    reason: z.enum(EXIT_REASONS),
    reasonText: z.string().max(EXIT_REASON_TEXT_MAX).nullable().optional(),
    choice: z.enum(['pause', 'discount', 'cancel']),
    /** Solo con `choice: 'pause'`. */
    pauseMonths: z.number().int().min(1).max(12).optional(),
  })
  .strict();
export type LeaveDto = z.infer<typeof leaveSchema>;

const between = (lim: { min: number; max: number }) => z.number().int().min(lim.min).max(lim.max);

/** «Cuando alguien quiere irse» (Ajustes de la creadora). */
export const retentionConfigSchema = z
  .object({
    pauseEnabled: z.boolean().optional(),
    pauseMaxMonths: between(RETENTION_LIMITS.pauseMaxMonths).optional(),
    discountEnabled: z.boolean().optional(),
    discountPercent: between(RETENTION_LIMITS.discountPercent).optional(),
    discountMonths: between(RETENTION_LIMITS.discountMonths).optional(),
  })
  .strict();
export type RetentionConfigDto = z.infer<typeof retentionConfigSchema>;
