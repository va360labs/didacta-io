/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Schema Zod del form SMTP, extraído del componente de UI para que pueda
 * importarse desde tests unitarios sin arrastrar React / JSX / 'use client'.
 *
 * El backend valida con el mismo shape — ver `SmtpUpsertSchema` en
 * `apps/api/src/admin/admin-smtp.controller.ts`. El único delta es que acá
 * usamos `coerce.number` para que un `<input type="number">` (que llega como
 * string en algunos browsers) se convierta antes de la validación de rango.
 */

import { z } from 'zod';

export const smtpFormSchema = z.object({
  host: z.string().trim().min(1, 'Host requerido').max(255),
  port: z.coerce.number().int().min(1, 'Puerto inválido').max(65535),
  secure: z.boolean(),
  username: z.string().trim().min(1, 'Usuario requerido').max(255),
  password: z.string().max(2048).optional(),
  fromEmail: z.string().trim().email('Email inválido').max(255),
  fromName: z.string().trim().max(255).optional(),
});

export type SmtpFormValues = z.infer<typeof smtpFormSchema>;
