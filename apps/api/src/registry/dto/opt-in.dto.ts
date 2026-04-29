/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * DTO Zod para POST /admin/registry/opt-in.
 */

import { z } from 'zod';

export const optInDtoSchema = z.object({
  email: z.string().email(),
  organizationName: z.string().min(1).max(200),
  deploymentUrl: z.string().url().optional(),
  /// Aceptación explícita de los términos. La constante `true` es obligatoria.
  acceptTerms: z.literal(true),
});

export type OptInDto = z.infer<typeof optInDtoSchema>;
