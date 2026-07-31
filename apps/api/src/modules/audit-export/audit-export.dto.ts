/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * DTOs Zod para los endpoints de `audit-export`. El gating runtime lo hace
 * el controller con @RequiresCapability(LICENSE_CAPABILITIES.REPORTS_ADVANCED_SIGNED).
 *
 * Validamos el rango temporal aquí en lugar de en el service para que cualquier
 * input malformado responda 400 antes de tocar Postgres.
 */

import { z } from 'zod';

/**
 * Schema de query string de `GET /audit/entries.zip`.
 * Ambos parámetros son opcionales (caso "todo el historial accesible"); si
 * ambos vienen, validamos que `from <= to`.
 */
export const auditExportRangeSchema = z
  .object({
    from: z
      .string({ message: 'from debe ser ISO 8601' })
      .datetime({ offset: true, message: 'from debe ser ISO 8601 con offset' })
      .optional(),
    to: z
      .string({ message: 'to debe ser ISO 8601' })
      .datetime({ offset: true, message: 'to debe ser ISO 8601 con offset' })
      .optional(),
  })
  .refine(
    (v) => {
      if (!v.from || !v.to) return true;
      return new Date(v.from).getTime() <= new Date(v.to).getTime();
    },
    { message: 'from debe ser <= to' },
  );

export type AuditExportRangeDto = z.infer<typeof auditExportRangeSchema>;
