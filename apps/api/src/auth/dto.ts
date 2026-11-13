/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';

// `tenantSlug` es OPCIONAL desde HU-SA-001 + LMS-110 (login transparente).
// El api resuelve el tenant por (a) Host header → tenant_domain, (b) email
// único entre tenants. El slug solo viaja explícito en flujos legacy o
// cuando el host no está mapeado.

export const signupSchema = z.object({
  tenantSlug: z.string().min(1).max(64).optional(),
  email: z.string().email(),
  password: z.string().min(12).max(128),
  name: z.string().min(1).max(120).optional(),
  /**
   * Zona horaria del navegador (IANA) y el idioma en el que estaba la página.
   * Solo se usan al CREAR la cuenta: sin ellos el alumno nacía en UTC y en
   * español aunque estuviera en Madrid y en un aula en inglés. Una zona que no
   * es IANA se ignora (cae a la del aula).
   */
  timezone: z.string().max(64).optional(),
  locale: z.string().max(10).optional(),
});
export type SignupDto = z.infer<typeof signupSchema>;

export const signinSchema = z.object({
  tenantSlug: z.string().min(1).max(64).optional(),
  // Sin espacios alrededor: el autocompletado del móvil deja uno detrás.
  email: z.string().trim().email(),
  password: z.string().min(1).max(128),
});
export type SigninDto = z.infer<typeof signinSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshDto = z.infer<typeof refreshSchema>;

export const forgotPasswordSchema = z.object({
  tenantSlug: z.string().min(1).max(64).optional(),
  email: z.string().trim().email(),
});
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(40).max(200),
  newPassword: z.string().min(12).max(128),
});
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;
