/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * DTO Zod para POST /branding/white-label/configure.
 * El DTO en sí es CE (cualquier dev necesita conocer el shape para construir
 * la request). El gating runtime lo hace el controller con @RequiresCapability.
 */

import { z } from 'zod';

export const configureWhiteLabelDtoSchema = z.object({
  logoUrl: z.string().url().optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color like #1a2b3c')
    .optional(),
  poweredByDidacta: z.boolean().optional(),
});

export type ConfigureWhiteLabelDto = z.infer<typeof configureWhiteLabelDtoSchema>;
