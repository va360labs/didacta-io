/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * DTO Zod para PUT /api/v1/admin/mfa-policy. El DTO en sí es CE (cualquier
 * dev necesita conocer el shape para construir la request). El gating runtime
 * lo hace el controller con @RequiresCapability(MFA_ENFORCEMENT).
 */

import { z } from 'zod';
import { MFA_GRACE_PERIOD_OPTIONS_DAYS } from './mfa-policy.types';

/**
 * Aceptamos cualquier entero entre 1 y 90 (rango razonable). Las opciones
 * "estándar" expuestas al admin desde la UI viven en `MFA_GRACE_PERIOD_OPTIONS_DAYS`,
 * pero permitimos cualquier valor del rango para clientes API que necesiten
 * personalizar (ej. compliance interna).
 */
export const updateMfaPolicyDtoSchema = z.object({
  requiredForAll: z.boolean(),
  gracePeriodDays: z
    .number()
    .int('gracePeriodDays debe ser un entero')
    .min(1, 'gracePeriodDays mínimo 1 día')
    .max(90, 'gracePeriodDays máximo 90 días'),
});

export type UpdateMfaPolicyDto = z.infer<typeof updateMfaPolicyDtoSchema>;

export { MFA_GRACE_PERIOD_OPTIONS_DAYS };
