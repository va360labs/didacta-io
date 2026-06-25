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
export const otpRequestSchema = z.object({
  email: z.string().email().max(320),
  ticket: z.string().min(1).max(2048),
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
  ticket: z.string().min(1).max(2048),
});
export type OtpVerifyDto = z.infer<typeof otpVerifySchema>;

export interface OtpVerifyResponse {
  ok: boolean;
  /** Token firmado que autoriza el paso 2 (crear la inscripción). */
  verificationToken: string;
}

// ─── PASO 2: crear la inscripción (User PENDING) ─────────────────────────────
export const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(200),
  bio: z.string().max(280).optional(),
  verificationToken: z.string().min(1).max(2048),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export interface RegisterResponse {
  ok: boolean;
  status: 'PENDING';
}

// ─── Admin: gestión de impagos (member_payment_flag) ─────────────────────────
export const paymentFlagUpsertSchema = z.object({
  telegramId: z.string().trim().min(1).max(32),
  name: z.string().max(200).nullable().optional(),
  isDelinquent: z.boolean().default(true),
  note: z.string().max(500).nullable().optional(),
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
  telegramId: string;
  inGroup: TelegramMembership;
  email: string;
  purpose: 'member-register';
  exp: number;
}
