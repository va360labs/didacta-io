/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente del slice de inscripción de miembros.
 *
 * Todos los endpoints de este flujo son PÚBLICOS (sin sesión): el aspirante
 * aún no tiene cuenta. Por eso usamos `apiFetch` SIN bearer. Same-origin en el
 * browser (paths `/api/v1/inscripcion/...`).
 *
 * El flujo en 3 pasos:
 *   1. Verificar identidad de Telegram (widget) → ticket.
 *   2. Verificar email por OTP usando el ticket → verificationToken.
 *   3. Crear la solicitud de inscripción con el verificationToken.
 */

import { ApiHttpError, apiFetch } from './api-client';
import type { RenewalTemplate } from './payment-connections';

// ── Tipos de respuesta (según contrato del backend) ──────────────────────────

/** Estado de pertenencia al grupo de Telegram de la comunidad. */
export type TelegramMembership = 'true' | 'false' | 'unknown';

export interface InscripcionConfig {
  /** Si el flujo está configurado (bot de Telegram disponible). */
  configured: boolean;
  /** Username del bot para el Telegram Login Widget. null si no configurado. */
  botUsername: string | null;
}

/** Payload que emite el Telegram Login Widget al autenticar. */
export interface TelegramAuthPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface VerifyTelegramResult {
  ok: boolean;
  /** Pertenencia al grupo: 'true' | 'false' | 'unknown'. */
  inGroup: TelegramMembership;
  /** Ticket opaco que ata el resto del flujo a esta verificación. */
  ticket: string;
}

export interface RequestOtpResult {
  ok: boolean;
  /** Segundos hasta que expira el código enviado. */
  expiresInSeconds: number;
}

export interface VerifyOtpResult {
  ok: boolean;
  /** Token que autoriza la creación de la solicitud (paso 3). */
  verificationToken: string;
}

export interface CreateInscripcionInput {
  name: string;
  password: string;
  bio?: string;
  verificationToken: string;
}

export interface CreateInscripcionResult {
  ok: boolean;
  status: 'PENDING';
}

// ── Funciones del cliente ─────────────────────────────────────────────────────

/**
 * Lee la configuración pública del flujo. El `botUsername` SIEMPRE viene de
 * aquí — nunca hardcodeado en la UI (regla #3). Si la API no responde, lo
 * tratamos como "no configurado" para que la pantalla muestre el mensaje de
 * indisponibilidad en lugar de romperse.
 */
export async function fetchInscripcionConfig(): Promise<InscripcionConfig> {
  try {
    return await apiFetch<InscripcionConfig>('/api/v1/inscripcion/config', { method: 'GET' });
  } catch {
    return { configured: false, botUsername: null };
  }
}

/** Verifica el payload del widget de Telegram. Devuelve pertenencia + ticket. */
export function verifyTelegram(payload: TelegramAuthPayload): Promise<VerifyTelegramResult> {
  return apiFetch<VerifyTelegramResult>('/api/v1/inscripcion/telegram/verify', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Solicita el envío de un código OTP al email del aspirante. */
export function requestOtp(email: string, ticket: string): Promise<RequestOtpResult> {
  return apiFetch<RequestOtpResult>('/api/v1/inscripcion/otp/request', {
    method: 'POST',
    body: JSON.stringify({ email, ticket }),
  });
}

/** Verifica el código OTP y devuelve el verificationToken para el paso final. */
export function verifyOtp(email: string, code: string, ticket: string): Promise<VerifyOtpResult> {
  return apiFetch<VerifyOtpResult>('/api/v1/inscripcion/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code, ticket }),
  });
}

/** Crea la solicitud de inscripción (queda PENDING de validación). */
export function createInscripcion(input: CreateInscripcionInput): Promise<CreateInscripcionResult> {
  return apiFetch<CreateInscripcionResult>('/api/v1/inscripcion/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Traduce cualquier error a un mensaje legible para la UI. Centraliza el manejo
 * de `ApiHttpError` para que los componentes no repitan el `instanceof`.
 */
export function inscripcionErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiHttpError ? error.message : fallback;
}

// ── Panel ADMIN de solicitudes (autenticado) ─────────────────────────────────

/** Una suscripción detectada del solicitante en una cuenta de pago conectada. */
export interface MemberSubscriptionMatch {
  provider: string;
  connectionName: string;
  planName: string | null;
  status: string;
  unitAmount: number | null;
  currency: string | null;
  subscriptionId: string;
}

/**
 * Una compra PUNTUAL (pedido) del solicitante. Es lo que justifica a quien
 * adquirió un "acceso lifetime" y por eso no tiene ninguna suscripción viva.
 */
export interface MemberPurchaseMatch {
  provider: string;
  connectionId: string;
  connectionName: string;
  orderId: string;
  orderNumber: string | null;
  status: string;
  /** Importe en la unidad MENOR de la moneda (céntimos). */
  total: number | null;
  currency: string | null;
  createdAt: string | null;
  products: string[];
}

export interface MemberRequest {
  userId: string;
  name: string | null;
  email: string;
  telegramId: string | null;
  telegramInGroup: boolean | null;
  createdAt: string;
  lookup: {
    /** PENDING | DONE | ERROR */
    status: string;
    matchCount: number;
    results: MemberSubscriptionMatch[];
    /** Compras puntuales detectadas (0 en lookups anteriores a esta función). */
    purchaseCount: number;
    purchases: MemberPurchaseMatch[];
    error: string | null;
    completedAt: string | null;
    /** Email con el que se consultó (puede diferir del de registro si el admin lo mapeó). */
    email: string | null;
  } | null;
}

const ADMIN_BASE = '/api/v1/inscripcion-admin';

/** Lista las solicitudes PENDING con su lookup de suscripción (todas las cuentas). */
export async function listMemberRequests(bearer: string): Promise<MemberRequest[]> {
  const res = await apiFetch<{ requests: MemberRequest[] }>(
    `${ADMIN_BASE}/requests`,
    { method: 'GET' },
    bearer,
  );
  return res.requests;
}

/**
 * Re-lanza el lookup de suscripción de un solicitante. Si se pasa `email`, consulta
 * por ESE email (para mapear una suscripción registrada con otro email) y lo persiste.
 */
export async function rerunMemberLookup(
  bearer: string,
  userId: string,
  email?: string,
): Promise<{
  matches: MemberSubscriptionMatch[];
  failures: Array<{ connectionName: string }>;
  email: string;
}> {
  return apiFetch(
    `${ADMIN_BASE}/requests/${encodeURIComponent(userId)}/rerun`,
    { method: 'POST', body: JSON.stringify(email ? { email } : {}) },
    bearer,
  );
}

/** Aprueba o rechaza una solicitud desde el panel (sin el link del email). */
export async function decideMemberRequest(
  bearer: string,
  userId: string,
  action: 'approve' | 'reject',
): Promise<{ outcome: 'approved' | 'rejected' }> {
  return apiFetch(
    `${ADMIN_BASE}/requests/${encodeURIComponent(userId)}/decision`,
    { method: 'POST', body: JSON.stringify({ action }) },
    bearer,
  );
}

/**
 * Prepara el recordatorio de pago de una suscripción detectada de la solicitud:
 * plantilla del tenant + enlace de renovación (Stripe). Reusa el motor de email
 * del dashboard de control de suscripciones.
 */
export async function memberRenewalContext(
  bearer: string,
  userId: string,
  subscriptionId?: string,
): Promise<{ template: RenewalTemplate; renewalUrl: string | null }> {
  const q = subscriptionId ? `?subscriptionId=${encodeURIComponent(subscriptionId)}` : '';
  return apiFetch(
    `${ADMIN_BASE}/requests/${encodeURIComponent(userId)}/renewal-context${q}`,
    { method: 'GET' },
    bearer,
  );
}

/** Envía el email de recordatorio de pago al email de la solicitud (SMTP del tenant). */
export async function sendMemberRenewalEmail(
  bearer: string,
  userId: string,
  payload: RenewalTemplate,
): Promise<{ ok: boolean; to: string }> {
  return apiFetch(
    `${ADMIN_BASE}/requests/${encodeURIComponent(userId)}/renewal-email`,
    { method: 'POST', body: JSON.stringify(payload) },
    bearer,
  );
}
