/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';
import { withdrawalWaiverSchema } from '../purchase-consent/withdrawal-waiver';

/**
 * DTOs zod de la membresía (página pública /unete + admin).
 * Importes SIEMPRE en céntimos (int) — nunca floats de dinero.
 */

export const membershipCheckoutSchema = z.object({
  planId: z.string().uuid(),
  /**
   * Email OPCIONAL para precargar el checkout de Stripe. No es dato de
   * confianza y no se usa para nada más: el email que manda es el confirmado
   * en el propio checkout (session.customer_details.email del webhook).
   */
  email: z.string().email().max(200).optional(),
  /**
   * Código de atribución OPCIONAL (programa de referidos, ?ref= de /unete).
   * Opaco para la membresía: viaja en la metadata de Stripe y lo interpreta
   * mod.referrals en el fulfillment. Formato del generador de códigos.
   */
  referralCode: z
    .string()
    .trim()
    .regex(/^[a-z0-9]{3,32}$/i)
    .optional(),
  /**
   * La casilla marcada antes de pagar: pide acceso inmediato y reconoce que
   * pierde el desistimiento de 14 días. Obligatoria (422 si falta).
   */
  withdrawalWaiver: withdrawalWaiverSchema.optional(),
});
export type MembershipCheckoutDto = z.infer<typeof membershipCheckoutSchema>;

const planShape = {
  name: z.string().trim().min(1).max(80),
  /**
   * Meses por periodo de facturación (1 mensual, 3 trimestral, 6 semestral,
   * 12 anual…). Tope 12: Stripe no admite periodos de más de un año.
   */
  intervalMonths: z.number().int().min(1).max(12),
  amountCents: z.number().int().min(0).max(100_000_000),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/)
    .optional(),
  /**
   * Precios fijos extra por mercado (`currency_options`): moneda ISO → importe
   * en su unidad mínima. Opción avanzada; `null` = ninguno.
   */
  currencyOptions: z
    .record(
      z
        .string()
        .regex(/^[a-zA-Z]{3}$/)
        .transform((c) => c.toLowerCase()),
      z.number().int().positive().max(100_000_000_00),
    )
    .nullable()
    .optional(),
  compareAtCents: z.number().int().min(1).max(100_000_000).nullable().optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  active: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
};

export const createPlanSchema = z.object(planShape);
export type CreatePlanDto = z.infer<typeof createPlanSchema>;

export const updatePlanSchema = z.object(planShape).partial();
export type UpdatePlanDto = z.infer<typeof updatePlanSchema>;

export const membershipConfigSchema = z
  .object({
    active: z.boolean(),
    headline: z.string().trim().min(1).max(120),
    subheadline: z.string().trim().max(300).nullable(),
    accessGroupId: z.string().uuid().nullable(),
    showCourses: z.boolean(),
    /** Lecciones visibles por curso durante el trial (0 = sin límite). */
    trialLessonLimit: z.number().int().min(0).max(1000),
    coursePrices: z
      .array(
        z.object({
          courseId: z.string().uuid(),
          amountCents: z.number().int().min(0).max(100_000_000),
        }),
      )
      .max(500),
    testimonialQuote: z.string().trim().max(600).nullable(),
    testimonialAuthor: z.string().trim().max(120).nullable(),
    testimonialRole: z.string().trim().max(120).nullable(),
  })
  .partial();
export type MembershipConfigDto = z.infer<typeof membershipConfigSchema>;
