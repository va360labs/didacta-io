/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';

// ============================================================================
// DTOs y tipos del flujo de inscripción de miembros (gate Telegram + OTP +
// validación manual). Validación con Zod (patrón del repo) + ZodValidationPipe.
// El backend es CORE del host: vive en apps/api/src/inscripcion/. Ver PRD Notion.
// ============================================================================

/** Tri-estado de pertenencia al grupo de Telegram. */
export type TelegramMembership = 'true' | 'false' | 'unknown';

/** Convierte el tri-estado del API al Boolean? que persiste la BD. */
export function membershipToBoolean(m: TelegramMembership): boolean | null {
  if (m === 'true') return true;
  if (m === 'false') return false;
  return null;
}

/** Convierte el Boolean? de la BD al tri-estado del API. */
export function membershipFromBoolean(b: boolean | null | undefined): TelegramMembership {
  if (b === true) return 'true';
  if (b === false) return 'false';
  return 'unknown';
}

// ─── PASO 1: payload del Telegram Login Widget ───────────────────────────────
export const telegramAuthSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((v) => String(v)),
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  username: z.string().max(100).optional(),
  photo_url: z.string().max(500).optional(),
  auth_date: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  hash: z.string().min(1).max(128),
});
export type TelegramAuthDto = z.infer<typeof telegramAuthSchema>;

export interface TelegramVerifyResponse {
  ok: boolean;
  inGroup: TelegramMembership;
  /** Ticket firmado de corta vida que autoriza el paso 1.5 (OTP). */
  ticket: string;
}

// ─── PASO 1.5a: solicitar código OTP ─────────────────────────────────────────
// `ticket` (del verificador de Telegram) solo se exige cuando la política del
// tenant incluye `telegram`; con OTP suelto el paso es directo.
export const otpRequestSchema = z.object({
  email: z.string().email().max(320),
  ticket: z.string().min(1).max(2048).optional(),
});
export type OtpRequestDto = z.infer<typeof otpRequestSchema>;

export interface OtpRequestResponse {
  ok: boolean;
  expiresInSeconds: number;
}

// ─── PASO 1.5b: verificar código OTP ─────────────────────────────────────────
export const otpVerifySchema = z.object({
  email: z.string().email().max(320),
  code: z.string().regex(/^\d{6}$/, 'El código debe tener 6 dígitos.'),
  ticket: z.string().min(1).max(2048).optional(),
});
export type OtpVerifyDto = z.infer<typeof otpVerifySchema>;

export interface OtpVerifyResponse {
  ok: boolean;
  /** Token firmado que autoriza el paso 2 (crear la inscripción). */
  verificationToken: string;
}

// ─── PASO 2: crear la inscripción (User PENDING) ─────────────────────────────
// La evidencia exigida depende de la política del tenant (el controller la
// valida): con `otp` → verificationToken (trae el email verificado); solo
// `telegram` → ticket + email del formulario; sin verificadores (registro
// libre) → email del formulario y nada más.
export const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(200),
  bio: z.string().max(280).optional(),
  email: z.string().email().max(320).optional(),
  verificationToken: z.string().min(1).max(2048).optional(),
  ticket: z.string().min(1).max(2048).optional(),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export interface RegisterResponse {
  ok: boolean;
  status: 'PENDING';
}

// ─── Admin: gestión de impagos (mod_member_registration_payment_flag) ────────
// Desde F2.3 la clave principal es el email; telegramId queda como clave
// legacy opcional (imports de exportaciones de Telegram, filas históricas).
// Al menos una de las dos debe venir.
export const paymentFlagUpsertSchema = z
  .object({
    email: z.string().trim().email().max(320).optional(),
    telegramId: z.string().trim().min(1).max(32).optional(),
    name: z.string().max(200).nullable().optional(),
    isDelinquent: z.boolean().default(true),
    note: z.string().max(500).nullable().optional(),
  })
  .refine((v) => Boolean(v.email?.length || v.telegramId?.length), {
    message: 'Se requiere email o telegramId.',
  });
export type PaymentFlagUpsertDto = z.infer<typeof paymentFlagUpsertSchema>;

export const paymentFlagImportSchema = z.object({
  rows: z.array(paymentFlagUpsertSchema).min(1).max(5000),
});
export type PaymentFlagImportDto = z.infer<typeof paymentFlagImportSchema>;

// ─── Claims de los tickets firmados (signed-ticket.ts) ───────────────────────
export interface TelegramTicketClaims {
  telegramId: string;
  inGroup: TelegramMembership;
  purpose: 'telegram';
  exp: number;
}

export interface VerificationTokenClaims {
  /** null cuando la política del tenant no incluye el verificador de Telegram. */
  telegramId: string | null;
  inGroup: TelegramMembership;
  email: string;
  purpose: 'member-register';
  exp: number;
}
