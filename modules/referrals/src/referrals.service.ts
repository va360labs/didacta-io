/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@didacta/database';
import {
  ReferralsCommissionNotFoundError,
  ReferralsCommissionStateError,
  ReferralsConfigValidationError,
  ReferralsCreditDisabledError,
  ReferralsCreditFailedError,
  ReferralsCreditNothingError,
  ReferralsCreditUnavailableError,
  ReferralsMembershipRequiredError,
  ReferralsPayoutValidationError,
  ReferralsProgramInactiveError,
  ReferralsTermsRequiredError,
  ReferralsPayeeInvalidError,
  ReferralsPayeeRequiredError,
  ReferralsPayeeUnavailableError,
  ReferralsPayoutAlreadyRequestedError,
  ReferralsPayoutNotFoundError,
} from './errors.js';
import {
  formatReceiptAmount,
  receiptLabel,
  receiptSecondLang,
  renderReceiptPdf,
  toReceiptLang,
  type ReceiptLine,
} from './receipt-pdf.js';
import {
  maskIban,
  maskTaxId,
  normalizePayee,
  PayeeValidationError,
  type PayeeDetails,
} from './payee.js';
import { deriveInviteeState, initialsOf, type InviteeState } from './invitees.js';

/**
 * mod.referrals — dominio puro (sin NestJS).
 *
 * Máquina de estados de una comisión:
 *
 *   (invoice.paid > 0 de sub atribuida) → PENDING ──worker/admin──▶ APPROVED ──payout──▶ PAID
 *                                            │                        │
 *                                            └────────admin──────────┴──▶ REVOKED (motivo)
 *
 * Reglas no negociables:
 *  - La comisión SOLO nace de un cobro real (invoice.paid con importe > 0):
 *    el trial a 0 € y los cupones del 100 % no devengan (JR-Freferrals.5).
 *  - Una invoice de Stripe = como mucho UNA comisión (unique stripeInvoiceId).
 *  - Un usuario referido se atribuye UNA vez por tenant (first-touch en el
 *    alta); la atribución es idempotente por suscripción de Stripe.
 *  - Auto-referido bloqueado por userId y por email normalizado.
 *  - Cambios de config NO recalculan comisiones existentes (los bps aplicados
 *    quedan sellados en cada fila).
 */

export interface ReferralsEventPublisher {
  publish(
    tenantId: string,
    actorId: string | null,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

/** Lookup de email de un user del core — lo implementa el host (el módulo no lee `user`). */
export type UserEmailLookup = (tenantId: string, userId: string) => Promise<string | null>;

/**
 * Saldo de cliente de Stripe de la suscripción del alumno, en la cuenta donde
 * vive esa suscripción (la del creador con Stripe propio; la del operador en
 * modo plataforma, donde `mod.payouts` descuenta el abono al creador). Lo
 * implementa el host con el adaptador de `mod.subscriptions`: el módulo no
 * habla con Stripe.
 */
export interface ReferralsCreditPort {
  retrieveBalance(
    tenantId: string,
    customerId: string,
  ): Promise<{ balanceCents: number; currency: string | null }>;
  credit(
    tenantId: string,
    params: {
      customerId: string;
      amountCents: number;
      currency: string;
      description: string;
      metadata: Record<string, string>;
      idempotencyKey: string;
    },
  ): Promise<{ id: string }>;
  /**
   * Retira saldo a favor (transacción POSITIVA): el descuento de referidos que
   * el alumno no gastó antes de darse de baja. Idempotente por clave.
   */
  debit?(
    tenantId: string,
    params: {
      customerId: string;
      amountCents: number;
      currency: string;
      description: string;
      metadata: Record<string, string>;
      idempotencyKey: string;
    },
  ): Promise<{ id: string }>;
}

/**
 * Tope del descuento: el 80 % de UNA cuota, contando lo que el alumno ya tenga
 * a favor. Así cada factura conserva un cobro real: con un cobro de 0 € el
 * operador se quedaría sin su comisión de ese mes (el reparto se hace sobre un
 * cargo) y un cargo minúsculo deja al creador con neto negativo.
 */
export const CREDIT_MAX_SHARE_BPS = 8000;

/**
 * Cifrado de los datos de cobro (AES-256-GCM con la clave maestra). Lo
 * implementa el host con `SecretCipherService`: el módulo no conoce la clave.
 */
export interface ReferralsCipher {
  encrypt(plaintext: string): { cipher: Buffer; iv: Buffer; tag: Buffer };
  decrypt(payload: { cipher: Buffer; iv: Buffer; tag: Buffer }): string;
}

/** Lo que el ALUMNO ve de sus datos de cobro: enmascarado. */
export interface PayeeMaskedView {
  fullName: string;
  country: string;
  taxIdMasked: string;
  ibanMasked: string;
  updatedAt: Date | null;
}

/**
 * Versión vigente de las condiciones del programa («Invita y gana»). Se guarda
 * con cada aceptación; si cambia, el alumno vuelve a aceptar para seguir
 * generando enlace.
 */
export const REFERRAL_TERMS_VERSION = '2026-11-13';

/** Lo que la página pública de condiciones necesita del programa de un aula. */
export interface ReferralsPublicTerms {
  version: string;
  active: boolean;
  commissionBps: number;
  scope: ReferralScope;
  recurringMonths: number | null;
  attributionWindowDays: number;
  guaranteeDays: number;
  minPayoutCents: number;
  allowCreditRedemption: boolean;
  /** Tope del descuento en cuota, en % de una cuota. */
  creditMaxSharePercent: number;
}

/** Cómo figura el descuento en la factura de la cuota (línea aparte). */
export const REFERRAL_CREDIT_LABEL = 'Pago con saldo de referidos';

/** Clave de idempotencia de la retirada del saldo al darse de baja. */
export function uncreditIdempotencyKey(payoutId: string): string {
  return `referrals-uncredit:${payoutId}`;
}

/** Clave de idempotencia del abono en Stripe: la fila de la liquidación. */
export function creditIdempotencyKey(payoutId: string): string {
  return `referrals-credit:${payoutId}`;
}

export interface MemberCreditView {
  /** Se puede canjear: opción encendida, puerto disponible y membresía viva con cliente. */
  enabled: boolean;
  /** Lo que se canjearía ahora (comisiones aprobadas sin pagar que caben en el tope). */
  availableCents: number;
  currency: string | null;
  /** Tope de una cuota (sin descontar lo que ya tenga a favor en Stripe). */
  maxCents: number;
  /** Hay un canje a medias (Stripe no confirmó): se reintenta con la misma clave. */
  pending: boolean;
}

export const REFERRALS_EVENT = {
  ATTRIBUTED: 'referrals.referral.attributed',
  COMMISSION_CREATED: 'referrals.commission.created',
  COMMISSION_APPROVED: 'referrals.commission.approved',
  COMMISSION_REVOKED: 'referrals.commission.revoked',
  PAYOUT_RECORDED: 'referrals.payout.recorded',
  CREDIT_RETURNED: 'referrals.credit.returned',
} as const;

export const REFERRAL_SCOPES = ['FIRST_PAYMENT', 'RECURRING'] as const;
export type ReferralScope = (typeof REFERRAL_SCOPES)[number];

export interface ReferralsConfigView {
  active: boolean;
  commissionBps: number;
  scope: ReferralScope;
  recurringMonths: number | null;
  attributionWindowDays: number;
  guaranteeDays: number;
  minPayoutCents: number;
  requireActiveMembership: boolean;
  memberCopy: string | null;
  /** El alumno puede cobrar lo ganado como descuento en su próxima cuota. */
  allowCreditRedemption: boolean;
}

export interface ReferralsConfigInput {
  active?: boolean;
  commissionBps?: number;
  scope?: ReferralScope;
  recurringMonths?: number | null;
  attributionWindowDays?: number;
  guaranteeDays?: number;
  minPayoutCents?: number;
  requireActiveMembership?: boolean;
  memberCopy?: string | null;
  allowCreditRedemption?: boolean;
}

const DEFAULT_CONFIG: ReferralsConfigView = {
  active: false,
  commissionBps: 3000,
  scope: 'RECURRING',
  recurringMonths: null,
  attributionWindowDays: 30,
  guaranteeDays: 14,
  minPayoutCents: 5000,
  // false por defecto: no toda academia vende membresías. El operador que sí
  // las venda puede exigir membresía viva del referidor desde la config.
  requireActiveMembership: false,
  memberCopy: null,
  // Encendido por defecto: el creador lo apaga en Ventas si no lo quiere.
  allowCreditRedemption: true,
};

export interface AttributeInput {
  tenantId: string;
  referralCode: string;
  referredUserId: string;
  stripeSubscriptionId: string;
  /** ID local de la suscripción de mod.subscriptions (lógico, sin FK). */
  subscriptionId: string;
  planId?: string | null;
}

export type AttributeResult =
  | { attributed: true; referralId: string; referrerUserId: string; alreadyExisted: boolean }
  | {
      attributed: false;
      reason:
        | 'program_inactive'
        | 'code_not_found'
        | 'self_referral'
        | 'already_attributed'
        | 'terms_not_accepted';
    };

export interface AccrueInput {
  tenantId: string;
  /** ID local de la suscripción de mod.subscriptions que cobró. */
  subscriptionId: string;
  stripeInvoiceId: string;
  amountCents: number;
  currency: string;
}

export type AccrueResult =
  | { accrued: true; commissionId: string; amountCents: number; alreadyExisted: boolean }
  | {
      accrued: false;
      reason:
        | 'zero_amount'
        | 'not_attributed'
        | 'out_of_scope'
        | 'referrer_membership_inactive'
        | 'zero_commission';
    };

/**
 * Una compra suelta (curso de pago único u otro producto de mod.billing) hecha
 * con el enlace de un referidor. La comisión se calcula igual que en la
 * membresía (mismo % sobre lo cobrado, misma garantía) y su referencia de
 * idempotencia es `purchaseInvoiceRef(orderId)`.
 */
export interface PurchaseInput {
  tenantId: string;
  /** Código del enlace con el que llegó el comprador (`?ref=`). */
  referralCode: string;
  /** Comprador ya materializado (el webhook de billing lo crea si no existía). */
  buyerUserId: string;
  /** Orden de mod.billing (ID lógico, sin FK). */
  orderId: string;
  /** Lo cobrado de verdad, en céntimos (amount_total de Stripe). */
  amountCents: number;
  currency: string;
}

export type PurchaseResult =
  | {
      accrued: true;
      commissionId: string;
      amountCents: number;
      referralId: string;
      referrerUserId: string;
      alreadyExisted: boolean;
    }
  | {
      accrued: false;
      reason:
        | 'program_inactive'
        | 'code_not_found'
        | 'self_referral'
        | 'terms_not_accepted'
        | Extract<AccrueResult, { accrued: false }>['reason'];
    };

/**
 * Referencia de idempotencia de la comisión de una compra suelta. Comparte
 * columna con las facturas de Stripe (`stripe_invoice_id`, única global): el
 * prefijo evita cualquier choque con un `in_…` real.
 */
export function purchaseInvoiceRef(orderId: string): string {
  return `order:${orderId}`;
}

/** Alfabeto sin caracteres confusos (sin 0/O, 1/l/i) para códigos legibles. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 8;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[(bytes[i] as number) % CODE_ALPHABET.length];
  }
  return out;
}

/** Tope de un canje: el {@link CREDIT_MAX_SHARE_BPS} de la cuota, a la baja. */
function creditCap(unitAmount: number): number {
  return Math.floor((unitAmount * CREDIT_MAX_SHARE_BPS) / 10_000);
}

/** Comisión que queda tras devolver `refunded` de una base, con el % sellado. */
function refundTarget(base: number, refunded: number, bps: number): number {
  return Math.round(((base - refunded) * bps) / 10_000);
}

/**
 * Qué entra en un cobro: las comisiones positivas que caben en `cap` (las más
 * antiguas primero) y, a continuación, los ajustes por devolución (negativos)
 * mientras el neto siga siendo positivo. Un ajuste que no cabe espera al
 * siguiente cobro: nunca deja un neto exigible.
 */
export function netAgainstAdjustments<T extends { amountCents: number }>(
  rows: readonly T[],
  cap: number,
): T[] {
  const picked: T[] = [];
  let total = 0;
  for (const r of rows) {
    if (r.amountCents <= 0 || total + r.amountCents > cap) continue;
    picked.push(r);
    total += r.amountCents;
  }
  for (const r of rows) {
    if (r.amountCents >= 0) continue;
    if (total + r.amountCents <= 0) continue;
    picked.push(r);
    total += r.amountCents;
  }
  return total > 0 ? picked : [];
}

/** Concepto de una línea del justificante. */
function receiptConcept(
  c: { amountCents: number; baseAmountCents: number; commissionBps: number; currency: string },
  second: 'en' | 'pt' | null,
): string {
  if (c.amountCents < 0) {
    if (second === 'pt') return 'Ajuste por devolución / Ajuste por reembolso';
    return second ? 'Ajuste por devolución / Refund adjustment' : 'Ajuste por devolución';
  }
  const pct = String(c.commissionBps / 100).replace('.', ',');
  const base = formatReceiptAmount(c.baseAmountCents, c.currency);
  if (second === 'pt') {
    return `Comisión del ${pct} % sobre ${base} / Comissão de ${pct} % sobre ${base}`;
  }
  return second
    ? `Comisión del ${pct} % sobre ${base} / ${pct}% commission on ${base}`
    : `Comisión del ${pct} % sobre una venta de ${base}`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** Día UTC YYYY-MM-DD (clave de dedupe de clics). */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export class ReferralsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: ReferralsEventPublisher,
    private readonly getUserEmail: UserEmailLookup,
    /** Sin puerto (tests, instancia sin Stripe) el canje como descuento no está disponible. */
    private readonly creditPort: ReferralsCreditPort | null = null,
    /** Sin cifrado no se guardan datos de cobro (el cobro en dinero no está disponible). */
    private readonly cipher: ReferralsCipher | null = null,
  ) {}

  // ---------------- Config ----------------

  async getConfig(tenantId: string): Promise<ReferralsConfigView> {
    const row = await this.prisma.modReferralsConfig.findUnique({ where: { tenantId } });
    if (!row) return { ...DEFAULT_CONFIG };
    return {
      active: row.active,
      commissionBps: row.commissionBps,
      scope: (REFERRAL_SCOPES as readonly string[]).includes(row.scope)
        ? (row.scope as ReferralScope)
        : 'RECURRING',
      recurringMonths: row.recurringMonths,
      attributionWindowDays: row.attributionWindowDays,
      guaranteeDays: row.guaranteeDays,
      minPayoutCents: row.minPayoutCents,
      requireActiveMembership: row.requireActiveMembership,
      memberCopy: row.memberCopy,
      allowCreditRedemption: row.allowCreditRedemption,
    };
  }

  async updateConfig(tenantId: string, input: ReferralsConfigInput): Promise<ReferralsConfigView> {
    if (
      input.commissionBps !== undefined &&
      (input.commissionBps < 0 || input.commissionBps > 10_000)
    ) {
      throw new ReferralsConfigValidationError(
        'commissionBps debe estar entre 0 y 10000 (0–100 %).',
      );
    }
    if (input.scope !== undefined && !REFERRAL_SCOPES.includes(input.scope)) {
      throw new ReferralsConfigValidationError(`scope inválido: ${String(input.scope)}`);
    }
    if (
      input.recurringMonths !== undefined &&
      input.recurringMonths !== null &&
      input.recurringMonths < 1
    ) {
      throw new ReferralsConfigValidationError('recurringMonths debe ser ≥ 1 o null (ilimitado).');
    }
    for (const field of ['attributionWindowDays', 'guaranteeDays', 'minPayoutCents'] as const) {
      const value = input[field];
      if (value !== undefined && value < 0) {
        throw new ReferralsConfigValidationError(`${field} no puede ser negativo.`);
      }
    }

    const current = await this.getConfig(tenantId);
    const next: ReferralsConfigView = {
      active: input.active ?? current.active,
      commissionBps: input.commissionBps ?? current.commissionBps,
      scope: input.scope ?? current.scope,
      recurringMonths:
        input.recurringMonths !== undefined ? input.recurringMonths : current.recurringMonths,
      attributionWindowDays: input.attributionWindowDays ?? current.attributionWindowDays,
      guaranteeDays: input.guaranteeDays ?? current.guaranteeDays,
      minPayoutCents: input.minPayoutCents ?? current.minPayoutCents,
      requireActiveMembership: input.requireActiveMembership ?? current.requireActiveMembership,
      memberCopy: input.memberCopy !== undefined ? input.memberCopy : current.memberCopy,
      allowCreditRedemption: input.allowCreditRedemption ?? current.allowCreditRedemption,
    };
    await this.prisma.modReferralsConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...next },
      update: next,
    });
    return next;
  }

  /** Condiciones públicas del programa con las cifras REALES del aula. */
  async publicTerms(tenantId: string): Promise<ReferralsPublicTerms> {
    const c = await this.getConfig(tenantId);
    return {
      version: REFERRAL_TERMS_VERSION,
      active: c.active,
      commissionBps: c.commissionBps,
      scope: c.scope,
      recurringMonths: c.recurringMonths,
      attributionWindowDays: c.attributionWindowDays,
      guaranteeDays: c.guaranteeDays,
      minPayoutCents: c.minPayoutCents,
      allowCreditRedemption: c.allowCreditRedemption,
      creditMaxSharePercent: CREDIT_MAX_SHARE_BPS / 100,
    };
  }

  // ---------------- Condiciones (mayor de 18) ----------------

  /** Qué aceptó el alumno y si es la versión vigente. */
  async termsStatus(
    tenantId: string,
    userId: string,
  ): Promise<{
    accepted: boolean;
    acceptedVersion: string | null;
    acceptedAt: Date | null;
    currentVersion: string;
  }> {
    const row = await this.prisma.modReferralsMember.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { termsVersion: true, termsAcceptedAt: true },
    });
    return {
      accepted: row?.termsVersion === REFERRAL_TERMS_VERSION && row.termsAcceptedAt !== null,
      acceptedVersion: row?.termsVersion ?? null,
      acceptedAt: row?.termsAcceptedAt ?? null,
      currentVersion: REFERRAL_TERMS_VERSION,
    };
  }

  /**
   * El alumno marca «Declaro que soy mayor de 18 años y acepto las condiciones
   * del programa». Se guardan la versión y la fecha. Solo vale la versión
   * vigente: aceptar una vieja no da enlace. Idempotente: repetir la misma
   * versión no cambia la fecha de la primera aceptación.
   */
  async acceptTerms(
    tenantId: string,
    userId: string,
    input: { version: string; adult: boolean },
    now: Date = new Date(),
  ): Promise<{ version: string; acceptedAt: Date }> {
    if (!input.adult || input.version !== REFERRAL_TERMS_VERSION) {
      throw new ReferralsTermsRequiredError();
    }
    const where = { tenantId_userId: { tenantId, userId } };
    const row = await this.prisma.modReferralsMember.findUnique({ where });
    if (row?.termsVersion === REFERRAL_TERMS_VERSION && row.termsAcceptedAt) {
      return { version: row.termsVersion, acceptedAt: row.termsAcceptedAt };
    }
    await this.prisma.modReferralsMember.upsert({
      where,
      create: { tenantId, userId, termsVersion: REFERRAL_TERMS_VERSION, termsAcceptedAt: now },
      update: { termsVersion: REFERRAL_TERMS_VERSION, termsAcceptedAt: now },
    });
    return { version: REFERRAL_TERMS_VERSION, acceptedAt: now };
  }

  /**
   * ¿Puede el dueño de un código generar comisiones? Basta con haber aceptado
   * ALGUNA versión: un cambio de condiciones pide aceptar de nuevo para
   * seguir compartiendo el enlace, pero no le quita lo que traigan los
   * enlaces ya compartidos con la versión anterior.
   */
  private async hasAcceptedAnyTerms(tenantId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.modReferralsMember.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { termsAcceptedAt: true },
    });
    return Boolean(row?.termsAcceptedAt);
  }

  // ---------------- Código y clics ----------------

  /**
   * Devuelve el código del usuario, creándolo si no existe. Lanza si el
   * programa está inactivo o si (con requireActiveMembership) el usuario no
   * tiene membresía viva — la UI comunica qué falta.
   */
  async getOrCreateCode(tenantId: string, userId: string): Promise<{ code: string }> {
    const config = await this.getConfig(tenantId);
    if (!config.active) throw new ReferralsProgramInactiveError();
    if (config.requireActiveMembership && !(await this.hasActiveMembership(tenantId, userId))) {
      throw new ReferralsMembershipRequiredError();
    }
    // Mayor de 18 y condiciones vigentes aceptadas: sin eso no hay enlace.
    if (!(await this.termsStatus(tenantId, userId)).accepted) {
      throw new ReferralsTermsRequiredError();
    }

    const existing = await this.prisma.modReferralsCode.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    if (existing) return { code: existing.code };

    // Colisión de slug: reintenta con otro random (el espacio es 31^8, chocar
    // dos veces seguidas es prácticamente imposible; 5 intentos por robustez).
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const created = await this.prisma.modReferralsCode.create({
          data: { tenantId, userId, code: generateCode() },
        });
        return { code: created.code };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Si la violación fue por (tenantId, userId) — carrera del mismo user —
        // el código ya existe: devuélvelo.
        const raced = await this.prisma.modReferralsCode.findUnique({
          where: { tenantId_userId: { tenantId, userId } },
        });
        if (raced) return { code: raced.code };
      }
    }
    throw new ReferralsConfigValidationError('No se pudo generar un código único.');
  }

  /**
   * Registra un clic de /join?ref=CODE. Best-effort silencioso: código
   * inválido, programa inactivo o clic duplicado (mismo día + misma IP)
   * devuelven false sin romper la página de venta.
   */
  async registerClick(
    tenantId: string,
    code: string,
    ipHash: string,
    day: string = utcDay(),
  ): Promise<boolean> {
    const config = await this.getConfig(tenantId);
    if (!config.active) return false;
    const codeRow = await this.prisma.modReferralsCode.findUnique({
      where: { tenantId_code: { tenantId, code } },
    });
    if (!codeRow) return false;
    try {
      await this.prisma.modReferralsClick.create({
        data: { tenantId, codeId: codeRow.id, day, ipHash },
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  // ---------------- Atribución (fulfillment del checkout) ----------------

  /**
   * Materializa la atribución referidor → referido al completarse el checkout
   * de la membresía. NUNCA lanza por datos inválidos (el fulfillment de la
   * membresía no puede romperse por un código malo): devuelve el motivo.
   */
  async attribute(input: AttributeInput): Promise<AttributeResult> {
    const config = await this.getConfig(input.tenantId);
    if (!config.active) return { attributed: false, reason: 'program_inactive' };

    // Idempotencia por suscripción de Stripe (reintentos del webhook).
    const bySub = await this.prisma.modReferralsReferral.findUnique({
      where: { stripeSubscriptionId: input.stripeSubscriptionId },
    });
    if (bySub) {
      return {
        attributed: true,
        referralId: bySub.id,
        referrerUserId: bySub.referrerUserId,
        alreadyExisted: true,
      };
    }

    const codeRow = await this.prisma.modReferralsCode.findUnique({
      where: { tenantId_code: { tenantId: input.tenantId, code: input.referralCode } },
    });
    if (!codeRow) return { attributed: false, reason: 'code_not_found' };

    // Anti-fraude: mismo usuario o mismo email normalizado.
    if (await this.isSelfReferral(input.tenantId, codeRow.userId, input.referredUserId)) {
      return { attributed: false, reason: 'self_referral' };
    }
    // Sin condiciones aceptadas el dueño del código no atribuye (enlaces viejos).
    if (!(await this.hasAcceptedAnyTerms(input.tenantId, codeRow.userId))) {
      return { attributed: false, reason: 'terms_not_accepted' };
    }

    // First-touch: un usuario referido solo se atribuye una vez por tenant.
    const byUser = await this.prisma.modReferralsReferral.findUnique({
      where: {
        tenantId_referredUserId: { tenantId: input.tenantId, referredUserId: input.referredUserId },
      },
    });
    if (byUser) return { attributed: false, reason: 'already_attributed' };

    try {
      const referral = await this.prisma.modReferralsReferral.create({
        data: {
          tenantId: input.tenantId,
          referrerUserId: codeRow.userId,
          referredUserId: input.referredUserId,
          code: input.referralCode,
          stripeSubscriptionId: input.stripeSubscriptionId,
          subscriptionId: input.subscriptionId,
          planId: input.planId ?? null,
        },
      });
      await this.publisher.publish(
        input.tenantId,
        input.referredUserId,
        REFERRALS_EVENT.ATTRIBUTED,
        {
          referralId: referral.id,
          referrerUserId: codeRow.userId,
          referredUserId: input.referredUserId,
          subscriptionId: input.subscriptionId,
        },
      );
      return {
        attributed: true,
        referralId: referral.id,
        referrerUserId: codeRow.userId,
        alreadyExisted: false,
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Carrera con otro webhook: alguien materializó antes. Tratamos como
        // atribución existente (por sub) o first-touch perdido (por user).
        const raced = await this.prisma.modReferralsReferral.findUnique({
          where: { stripeSubscriptionId: input.stripeSubscriptionId },
        });
        if (raced) {
          return {
            attributed: true,
            referralId: raced.id,
            referrerUserId: raced.referrerUserId,
            alreadyExisted: true,
          };
        }
        return { attributed: false, reason: 'already_attributed' };
      }
      throw err;
    }
  }

  // ---------------- Devengo (invoice.paid) ----------------

  /**
   * Devenga la comisión de un cobro real. Idempotente por invoice de Stripe.
   * No lanza por reglas de negocio (el caller loguea el motivo): el flujo de
   * facturación jamás se rompe por el programa de referidos.
   */
  async accrueCommission(input: AccrueInput): Promise<AccrueResult> {
    if (input.amountCents <= 0) return { accrued: false, reason: 'zero_amount' };

    const referral = await this.prisma.modReferralsReferral.findFirst({
      where: { tenantId: input.tenantId, subscriptionId: input.subscriptionId },
    });
    if (!referral) return { accrued: false, reason: 'not_attributed' };

    return this.accrueForReferral(referral, input);
  }

  // ---------------- Compra suelta (billing.order.completed) ----------------

  /**
   * Comisión por una compra suelta hecha con el enlace de un referidor (curso
   * de pago único y cualquier otro producto que cobre mod.billing).
   *
   * - Mismas reglas que la membresía: programa activo, código del aula,
   *   nada de autorreferidos (mismo usuario o mismo email), mismo % sobre lo
   *   cobrado, PENDING hasta que pasa la garantía y anulable por reembolso.
   * - First-touch por aula: si el comprador ya era referido de alguien (por
   *   una membresía o una compra anterior), la comisión va a ESE referidor; si
   *   no, esta compra crea el referido apuntando a la orden.
   * - Idempotente por orden (`purchaseInvoiceRef`): un webhook reentregado no
   *   duplica nada.
   *
   * No lanza por reglas de negocio: el fulfillment de la compra jamás se
   * rompe por el programa de referidos (el caller loguea el motivo).
   */
  async recordPurchase(input: PurchaseInput): Promise<PurchaseResult> {
    if (input.amountCents <= 0) return { accrued: false, reason: 'zero_amount' };
    const config = await this.getConfig(input.tenantId);
    if (!config.active) return { accrued: false, reason: 'program_inactive' };

    const codeRow = await this.prisma.modReferralsCode.findUnique({
      where: { tenantId_code: { tenantId: input.tenantId, code: input.referralCode } },
    });
    if (!codeRow) return { accrued: false, reason: 'code_not_found' };
    if (await this.isSelfReferral(input.tenantId, codeRow.userId, input.buyerUserId)) {
      return { accrued: false, reason: 'self_referral' };
    }
    if (!(await this.hasAcceptedAnyTerms(input.tenantId, codeRow.userId))) {
      return { accrued: false, reason: 'terms_not_accepted' };
    }

    const referral = await this.findOrCreatePurchaseReferral(input, codeRow.userId);
    const result = await this.accrueForReferral(referral, {
      tenantId: input.tenantId,
      stripeInvoiceId: purchaseInvoiceRef(input.orderId),
      amountCents: input.amountCents,
      currency: input.currency,
    });
    if (!result.accrued) return result;
    return {
      ...result,
      referralId: referral.id,
      referrerUserId: referral.referrerUserId,
    };
  }

  private async findOrCreatePurchaseReferral(
    input: PurchaseInput,
    referrerUserId: string,
  ): Promise<{ id: string; referrerUserId: string; attributedAt: Date }> {
    const where = {
      tenantId_referredUserId: { tenantId: input.tenantId, referredUserId: input.buyerUserId },
    };
    const existing = await this.prisma.modReferralsReferral.findUnique({ where });
    if (existing) return existing;
    try {
      const referral = await this.prisma.modReferralsReferral.create({
        data: {
          tenantId: input.tenantId,
          referrerUserId,
          referredUserId: input.buyerUserId,
          code: input.referralCode,
          orderId: input.orderId,
        },
      });
      await this.publisher.publish(input.tenantId, input.buyerUserId, REFERRALS_EVENT.ATTRIBUTED, {
        referralId: referral.id,
        referrerUserId,
        referredUserId: input.buyerUserId,
        subscriptionId: null,
        orderId: input.orderId,
      });
      return referral;
    } catch (err) {
      // Carrera con otro webhook del mismo comprador: gana el primero.
      if (isUniqueViolation(err)) {
        const raced = await this.prisma.modReferralsReferral.findUnique({ where });
        if (raced) return raced;
      }
      throw err;
    }
  }

  /** Mismo usuario o mismo email normalizado que el dueño del código. */
  private async isSelfReferral(
    tenantId: string,
    codeOwnerUserId: string,
    buyerUserId: string,
  ): Promise<boolean> {
    if (codeOwnerUserId === buyerUserId) return true;
    const [referrerEmail, referredEmail] = await Promise.all([
      this.getUserEmail(tenantId, codeOwnerUserId),
      this.getUserEmail(tenantId, buyerUserId),
    ]);
    const a = normalizeEmail(referrerEmail);
    const b = normalizeEmail(referredEmail);
    return a !== null && a === b;
  }

  /**
   * Núcleo común del devengo (membresía y compra suelta): idempotencia por
   * referencia de cobro, ámbito, membresía del referidor y cálculo.
   */
  private async accrueForReferral(
    referral: { id: string; referrerUserId: string; attributedAt: Date },
    input: { tenantId: string; stripeInvoiceId: string; amountCents: number; currency: string },
  ): Promise<AccrueResult> {
    const existing = await this.prisma.modReferralsCommission.findUnique({
      where: { stripeInvoiceId: input.stripeInvoiceId },
    });
    if (existing) {
      return {
        accrued: true,
        commissionId: existing.id,
        amountCents: existing.amountCents,
        alreadyExisted: true,
      };
    }

    const config = await this.getConfig(input.tenantId);
    const now = new Date();

    if (config.scope === 'FIRST_PAYMENT') {
      const priorCount = await this.prisma.modReferralsCommission.count({
        where: { referralId: referral.id },
      });
      if (priorCount > 0) return { accrued: false, reason: 'out_of_scope' };
    } else if (config.recurringMonths !== null) {
      const windowEnd = new Date(referral.attributedAt);
      windowEnd.setMonth(windowEnd.getMonth() + config.recurringMonths);
      if (now > windowEnd) return { accrued: false, reason: 'out_of_scope' };
    }

    if (
      config.requireActiveMembership &&
      !(await this.hasActiveMembership(input.tenantId, referral.referrerUserId))
    ) {
      return { accrued: false, reason: 'referrer_membership_inactive' };
    }

    const amountCents = Math.round((input.amountCents * config.commissionBps) / 10_000);
    if (amountCents <= 0) return { accrued: false, reason: 'zero_commission' };

    const approveAfter = new Date(now.getTime() + config.guaranteeDays * 24 * 60 * 60 * 1000);
    try {
      const commission = await this.prisma.modReferralsCommission.create({
        data: {
          tenantId: input.tenantId,
          referralId: referral.id,
          referrerUserId: referral.referrerUserId,
          stripeInvoiceId: input.stripeInvoiceId,
          baseAmountCents: input.amountCents,
          amountCents,
          currency: input.currency,
          commissionBps: config.commissionBps,
          status: 'PENDING',
          approveAfter,
        },
      });
      await this.publisher.publish(
        input.tenantId,
        referral.referrerUserId,
        REFERRALS_EVENT.COMMISSION_CREATED,
        {
          commissionId: commission.id,
          referralId: referral.id,
          referrerUserId: referral.referrerUserId,
          amountCents,
          baseAmountCents: input.amountCents,
          currency: input.currency,
          sourceInvoiceId: input.stripeInvoiceId,
        },
      );
      return { accrued: true, commissionId: commission.id, amountCents, alreadyExisted: false };
    } catch (err) {
      if (isUniqueViolation(err)) {
        const raced = await this.prisma.modReferralsCommission.findUnique({
          where: { stripeInvoiceId: input.stripeInvoiceId },
        });
        if (raced) {
          return {
            accrued: true,
            commissionId: raced.id,
            amountCents: raced.amountCents,
            alreadyExisted: true,
          };
        }
      }
      throw err;
    }
  }

  // ---------------- Ciclo de vida de comisiones ----------------

  /**
   * Mitad «sweep» de la aprobación de comisiones (patrón F3): tenants con al
   * menos una comisión PENDING cuya garantía venció. El worker la invoca bajo
   * acceso global sancionado y procesa cada tenant con su contexto RLS.
   */
  async findTenantsWithDueCommissions(now: Date = new Date()): Promise<string[]> {
    const rows = await this.prisma.modReferralsCommission.findMany({
      where: { status: 'PENDING', approveAfter: { lte: now } },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    return [...new Set(rows.map((r) => r.tenantId))];
  }

  /**
   * Mitad «procesado» (por tenant): PENDING → APPROVED para las comisiones
   * del tenant cuya garantía venció. Devuelve cuántas aprobó.
   */
  async approveDueCommissionsForTenant(tenantId: string, now: Date = new Date()): Promise<number> {
    const due = await this.prisma.modReferralsCommission.findMany({
      where: { tenantId, status: 'PENDING', approveAfter: { lte: now } },
      take: 500,
    });
    let approved = 0;
    for (const commission of due) {
      const result = await this.prisma.modReferralsCommission.updateMany({
        where: { id: commission.id, tenantId, status: 'PENDING' },
        data: { status: 'APPROVED', approvedAt: now },
      });
      if (result.count === 0) continue; // otro proceso la tocó — no-op
      approved++;
      await this.publisher.publish(
        commission.tenantId,
        commission.referrerUserId,
        REFERRALS_EVENT.COMMISSION_APPROVED,
        { commissionId: commission.id, referrerUserId: commission.referrerUserId },
      );
    }
    return approved;
  }

  /**
   * Barrido global: composición sweep + por-tenant. La conserva la API del
   * módulo (tests, llamadas in-process); el worker BullMQ usa las dos mitades
   * por separado para escopar el procesado por tenant.
   */
  async approveDueCommissions(now: Date = new Date()): Promise<number> {
    const tenants = await this.findTenantsWithDueCommissions(now);
    let approved = 0;
    for (const tenantId of tenants) {
      approved += await this.approveDueCommissionsForTenant(tenantId, now);
    }
    return approved;
  }

  /** Aprobación manual anticipada por el admin (PENDING → APPROVED). */
  async approveCommissionNow(tenantId: string, commissionId: string): Promise<void> {
    const commission = await this.prisma.modReferralsCommission.findFirst({
      where: { id: commissionId, tenantId },
    });
    if (!commission) throw new ReferralsCommissionNotFoundError(commissionId);
    if (commission.status !== 'PENDING') {
      throw new ReferralsCommissionStateError(
        `Solo se puede aprobar una comisión PENDING (estado actual: ${commission.status}).`,
      );
    }
    await this.prisma.modReferralsCommission.update({
      where: { id: commissionId },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    await this.publisher.publish(
      tenantId,
      commission.referrerUserId,
      REFERRALS_EVENT.COMMISSION_APPROVED,
      {
        commissionId,
        referrerUserId: commission.referrerUserId,
      },
    );
  }

  /** Revocación del admin con motivo obligatorio (PENDING/APPROVED → REVOKED). */
  async revokeCommission(
    tenantId: string,
    commissionId: string,
    reason: string,
    actorId: string | null,
  ): Promise<void> {
    if (!reason.trim()) {
      throw new ReferralsCommissionStateError('La revocación requiere un motivo.');
    }
    const commission = await this.prisma.modReferralsCommission.findFirst({
      where: { id: commissionId, tenantId },
    });
    if (!commission) throw new ReferralsCommissionNotFoundError(commissionId);
    if (commission.status !== 'PENDING' && commission.status !== 'APPROVED') {
      throw new ReferralsCommissionStateError(
        `No se puede revocar una comisión ${commission.status} (las pagadas son definitivas).`,
      );
    }
    await this.prisma.modReferralsCommission.update({
      where: { id: commissionId },
      data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason.trim() },
    });
    await this.publisher.publish(tenantId, actorId, REFERRALS_EVENT.COMMISSION_REVOKED, {
      commissionId,
      referrerUserId: commission.referrerUserId,
      reason: reason.trim(),
    });
  }

  /**
   * Reembolso TOTAL del cobro origen (`subscriptions.invoice.refunded`,
   * `billing.order.refunded`). Con la comisión aún sin cobrar, se anula; ya
   * cobrada (en dinero o como descuento), queda un ajuste negativo que se
   * descuenta de lo siguiente que gane. No lanza: el bridge loguea.
   */
  async revokeCommissionByInvoice(
    tenantId: string,
    stripeInvoiceId: string,
    reason: string,
  ): Promise<
    | { revoked: true; commissionId: string }
    | { revoked: false; reason: 'not_found' | 'already_revoked' }
    | { revoked: false; reason: 'already_paid'; adjustmentId: string | null }
  > {
    const result = await this.applyRefund(
      tenantId,
      stripeInvoiceId,
      { refundedCents: 1, totalCents: 1 },
      reason,
    );
    if (result.action === 'not_found') return { revoked: false, reason: 'not_found' };
    if (result.action === 'already_revoked' || result.action === 'no_change') {
      return { revoked: false, reason: 'already_revoked' };
    }
    if (result.action === 'adjusted') {
      return { revoked: false, reason: 'already_paid', adjustmentId: result.adjustmentId };
    }
    if (result.action === 'revoked' || result.action === 'reduced') {
      return { revoked: true, commissionId: result.commissionId };
    }
    return { revoked: false, reason: 'not_found' };
  }

  /**
   * Reembolso (total o PARCIAL) del cobro origen: recorta la comisión en la
   * misma proporción. `refundedCents` es lo devuelto ACUMULADO (como lo da
   * Stripe) sobre `totalCents`: un evento reentregado no recorta dos veces.
   *
   * - Comisión sin cobrar (PENDING, o APPROVED sin liquidar): baja su importe;
   *   si llega a 0, se anula (REVOKED).
   * - Ya cobrada o reservada en un cobro: fila ADJUSTMENT negativa, APPROVED y
   *   sin liquidar, que se descuenta de lo siguiente que gane. Nunca deja un
   *   saldo exigible al alumno: si no gana más, se queda ahí.
   */
  async applyRefund(
    tenantId: string,
    stripeInvoiceId: string,
    refund: { refundedCents: number; totalCents: number },
    reason: string,
  ): Promise<
    | { action: 'not_found' | 'already_revoked' | 'no_change' }
    | { action: 'reduced' | 'revoked'; commissionId: string; amountCents: number }
    | { action: 'adjusted'; commissionId: string; adjustmentId: string | null; amountCents: number }
  > {
    const c = await this.prisma.modReferralsCommission.findUnique({ where: { stripeInvoiceId } });
    if (!c || c.tenantId !== tenantId || c.kind !== 'COMMISSION') return { action: 'not_found' };
    if (c.status === 'REVOKED') return { action: 'already_revoked' };
    const base = c.baseAmountCents;
    const refunded =
      refund.totalCents > 0
        ? Math.min(base, Math.round((base * refund.refundedCents) / refund.totalCents))
        : base;
    if (refunded <= c.refundedBaseCents) return { action: 'no_change' };
    const target = refundTarget(base, refunded, c.commissionBps);
    const previous = refundTarget(base, c.refundedBaseCents, c.commissionBps);
    const cut = previous - target;

    // Sin cobrar: se recorta (o se anula) la propia comisión.
    if (c.status === 'PENDING' || (c.status === 'APPROVED' && c.payoutId === null)) {
      const revoke = target <= 0;
      const updated = await this.prisma.modReferralsCommission.updateMany({
        where: {
          id: c.id,
          tenantId,
          status: { in: ['PENDING', 'APPROVED'] },
          payoutId: null,
          refundedBaseCents: c.refundedBaseCents,
        },
        data: {
          amountCents: Math.max(0, target),
          refundedBaseCents: refunded,
          ...(revoke ? { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason } : {}),
        },
      });
      if (updated.count === 1) {
        if (revoke) {
          await this.publisher.publish(tenantId, null, REFERRALS_EVENT.COMMISSION_REVOKED, {
            commissionId: c.id,
            referrerUserId: c.referrerUserId,
            reason,
          });
        }
        return { action: revoke ? 'revoked' : 'reduced', commissionId: c.id, amountCents: target };
      }
      // Carrera con un cobro o con otro reembolso: se trata como ya cobrada.
      return this.applyRefund(tenantId, stripeInvoiceId, refund, reason);
    }

    // Ya cobrada (o reservada en un cobro en dinero): ajuste negativo.
    const now = new Date();
    try {
      const adjustmentId = await this.prisma.$transaction(async (tx) => {
        const db = tx as unknown as PrismaClient;
        const moved = await db.modReferralsCommission.updateMany({
          where: { id: c.id, tenantId, refundedBaseCents: c.refundedBaseCents },
          data: { refundedBaseCents: refunded },
        });
        if (moved.count !== 1) return null;
        if (cut <= 0) return null;
        const adj = await db.modReferralsCommission.create({
          data: {
            tenantId,
            referralId: c.referralId,
            referrerUserId: c.referrerUserId,
            stripeInvoiceId: `refund-adjust:${c.id}:${refunded}`,
            baseAmountCents: -(refunded - c.refundedBaseCents),
            amountCents: -cut,
            currency: c.currency,
            commissionBps: c.commissionBps,
            kind: 'ADJUSTMENT',
            adjustsCommissionId: c.id,
            status: 'APPROVED',
            approveAfter: now,
            approvedAt: now,
            revokeReason: reason,
          },
        });
        return adj.id;
      });
      return { action: 'adjusted', commissionId: c.id, adjustmentId, amountCents: -cut };
    } catch (err) {
      if (isUniqueViolation(err)) return { action: 'no_change' };
      throw err;
    }
  }

  // ---------------- Liquidación ----------------

  /**
   * Marca un lote de comisiones APPROVED como PAID en una liquidación con
   * referencia externa. Atómica: o todo el lote o nada.
   */
  async recordPayout(
    tenantId: string,
    input: {
      referrerUserId: string;
      commissionIds: string[];
      externalReference: string;
      createdByUserId: string;
    },
  ): Promise<{ payoutId: string; totalCents: number; currency: string; count: number }> {
    if (input.commissionIds.length === 0) {
      throw new ReferralsPayoutValidationError('La liquidación necesita al menos una comisión.');
    }
    if (!input.externalReference.trim()) {
      throw new ReferralsPayoutValidationError(
        'La referencia externa del pago (transferencia, PayPal…) es obligatoria.',
      );
    }
    const commissions = await this.prisma.modReferralsCommission.findMany({
      where: { id: { in: input.commissionIds }, tenantId },
    });
    if (commissions.length !== input.commissionIds.length) {
      throw new ReferralsPayoutValidationError(
        'Alguna comisión del lote no existe en este tenant.',
      );
    }
    for (const c of commissions) {
      if (c.status !== 'APPROVED') {
        throw new ReferralsPayoutValidationError(
          `La comisión ${c.id} no está APPROVED (estado: ${c.status}).`,
        );
      }
      if (c.referrerUserId !== input.referrerUserId) {
        throw new ReferralsPayoutValidationError(
          'Todas las comisiones del lote deben ser del mismo referidor.',
        );
      }
    }
    const currencies = new Set(commissions.map((c) => c.currency));
    if (currencies.size > 1) {
      throw new ReferralsPayoutValidationError('No se pueden mezclar monedas en una liquidación.');
    }
    const currency = commissions[0]!.currency;
    // Los ajustes por devolución pendientes del referidor se descuentan de
    // este pago (mientras quede algo que pagar).
    const adjustments = await this.prisma.modReferralsCommission.findMany({
      where: {
        tenantId,
        referrerUserId: input.referrerUserId,
        status: 'APPROVED',
        payoutId: null,
        currency,
        amountCents: { lt: 0 },
        id: { notIn: input.commissionIds },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, amountCents: true },
    });
    const netted = netAgainstAdjustments(
      [...commissions.map((c) => ({ id: c.id, amountCents: c.amountCents })), ...adjustments],
      Number.POSITIVE_INFINITY,
    );
    input = { ...input, commissionIds: netted.map((r) => r.id) };
    const totalCents = netted.reduce((sum, c) => sum + c.amountCents, 0);
    if (totalCents <= 0) {
      throw new ReferralsPayoutValidationError(
        'Con los ajustes por devolución pendientes no queda nada que pagar.',
      );
    }

    const config = await this.getConfig(tenantId);
    if (config.minPayoutCents > 0 && totalCents < config.minPayoutCents) {
      throw new ReferralsPayoutValidationError(
        `El total (${totalCents} cts) no llega al mínimo de liquidación (${config.minPayoutCents} cts).`,
      );
    }

    // Una liquidación en dinero también lleva su justificante numerado.
    const snapshot = this.cipher ? await this.payeeSnapshot(tenantId, input.referrerUserId) : {};
    let payoutId = '';
    const numbered = async (tx: PrismaClient, receiptNumber: number | null) => {
      const payout = await tx.modReferralsPayout.create({
        data: {
          tenantId,
          referrerUserId: input.referrerUserId,
          totalCents,
          currency,
          externalReference: input.externalReference.trim(),
          createdByUserId: input.createdByUserId,
          paidAt: new Date(),
          receiptNumber,
          ...snapshot,
        },
      });
      const updated = await tx.modReferralsCommission.updateMany({
        where: { id: { in: input.commissionIds }, tenantId, status: 'APPROVED' },
        data: { status: 'PAID', payoutId: payout.id },
      });
      if (updated.count !== input.commissionIds.length) {
        // Carrera: alguien tocó una comisión del lote entre la validación y
        // el update — rollback de TODO (atomicidad).
        throw new ReferralsPayoutValidationError(
          'El lote cambió durante la liquidación; reintenta.',
        );
      }
      payoutId = payout.id;
    };
    if (this.cipher) {
      await this.withReceiptNumber(tenantId, (db, n) => numbered(db, n));
    } else {
      await this.prisma.$transaction(async (tx) => numbered(tx as unknown as PrismaClient, null));
    }

    await this.publisher.publish(tenantId, input.createdByUserId, REFERRALS_EVENT.PAYOUT_RECORDED, {
      payoutId,
      referrerUserId: input.referrerUserId,
      totalCents,
      currency,
      commissionCount: input.commissionIds.length,
      externalReference: input.externalReference.trim(),
    });
    return { payoutId, totalCents, currency, count: input.commissionIds.length };
  }

  // ---------------- Baja con descuento sin usar ----------------

  /**
   * El alumno canceló su membresía: el saldo de referidos que siga a favor
   * en su cliente de Stripe se retira y vuelve a su cartera como comisión
   * confirmada (`kind = CREDIT_RETURN`), para cobrarla en dinero.
   *
   * - Solo lo que vino de referidos: como mucho lo abonado por canjes
   *   (`CREDIT`) menos lo ya devuelto, y como mucho el saldo a favor actual.
   * - Si el mismo cliente sigue con otra membresía viva, no se toca nada.
   * - Idempotente: la liquidación `CREDIT_REVERSAL` nace PENDING (una por
   *   cliente), la retirada usa `referrals-uncredit:<id>` y el cierre crea la
   *   fila de cartera con referencia única. Un reintento termina el mismo.
   *
   * No lanza: el bridge loguea el motivo (la baja jamás falla por esto).
   */
  async returnUnusedCredit(
    tenantId: string,
    input: { userId: string; subscriptionId: string },
  ): Promise<
    | { returned: true; payoutId: string; amountCents: number; currency: string }
    | {
        returned: false;
        reason: 'no_port' | 'no_customer' | 'still_member' | 'nothing_to_return';
      }
  > {
    const port = this.creditPort;
    if (!port?.debit) return { returned: false, reason: 'no_port' };
    const sub = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: { id: input.subscriptionId, tenantId, userId: input.userId },
      select: { stripeCustomerId: true, currency: true },
    });
    const customerId = sub?.stripeCustomerId;
    if (!customerId?.startsWith('cus_')) return { returned: false, reason: 'no_customer' };
    const alive = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: {
        tenantId,
        stripeCustomerId: customerId,
        planId: { not: null },
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      },
      select: { id: true },
    });
    if (alive) return { returned: false, reason: 'still_member' };

    // Una retirada a medias se termina antes de abrir otra.
    const pending = await this.prisma.modReferralsPayout.findFirst({
      where: {
        tenantId,
        stripeCustomerId: customerId,
        method: 'CREDIT_REVERSAL',
        status: 'PENDING',
      },
    });
    let payout = pending;
    if (!payout) {
      const [credited, reversed] = await Promise.all([
        this.prisma.modReferralsPayout.aggregate({
          where: {
            tenantId,
            referrerUserId: input.userId,
            stripeCustomerId: customerId,
            method: 'CREDIT',
            status: 'DONE',
          },
          _sum: { totalCents: true },
        }),
        this.prisma.modReferralsPayout.aggregate({
          where: {
            tenantId,
            referrerUserId: input.userId,
            stripeCustomerId: customerId,
            method: 'CREDIT_REVERSAL',
            status: 'DONE',
          },
          _sum: { totalCents: true },
        }),
      ]);
      // Las retiradas se guardan en negativo.
      const fromReferrals = (credited._sum.totalCents ?? 0) + (reversed._sum.totalCents ?? 0);
      if (fromReferrals <= 0) return { returned: false, reason: 'nothing_to_return' };
      let balance: { balanceCents: number; currency: string | null };
      try {
        balance = await port.retrieveBalance(tenantId, customerId);
      } catch {
        throw new ReferralsCreditFailedError();
      }
      const available = Math.max(0, -balance.balanceCents);
      const amount = Math.min(available, fromReferrals);
      if (amount <= 0) return { returned: false, reason: 'nothing_to_return' };
      const currency = (balance.currency ?? sub?.currency ?? 'eur').toLowerCase();
      try {
        payout = await this.prisma.modReferralsPayout.create({
          data: {
            tenantId,
            referrerUserId: input.userId,
            totalCents: -amount,
            currency,
            externalReference: 'pendiente',
            createdByUserId: input.userId,
            method: 'CREDIT_REVERSAL',
            status: 'PENDING',
            stripeCustomerId: customerId,
          },
        });
      } catch (err) {
        // Otra baja procesando el mismo cliente a la vez: termina la suya.
        if (!isUniqueViolation(err)) throw err;
        payout = await this.prisma.modReferralsPayout.findFirst({
          where: {
            tenantId,
            stripeCustomerId: customerId,
            method: 'CREDIT_REVERSAL',
            status: 'PENDING',
          },
        });
        if (!payout) throw err;
      }
    }

    const amountCents = -payout.totalCents;
    let tx: { id: string };
    try {
      tx = await port.debit(tenantId, {
        customerId,
        amountCents,
        currency: payout.currency,
        description: `${REFERRAL_CREDIT_LABEL}: saldo sin usar devuelto al darse de baja`,
        metadata: {
          didacta_kind: 'referral_credit_return',
          didacta_tenant_id: tenantId,
          didacta_referral_payout_id: payout.id,
        },
        idempotencyKey: uncreditIdempotencyKey(payout.id),
      });
    } catch {
      // La fila sigue PENDING: el siguiente intento repite la MISMA llamada.
      throw new ReferralsCreditFailedError();
    }

    const referral = await this.prisma.modReferralsReferral.findFirst({
      where: { tenantId, referrerUserId: input.userId },
      orderBy: { attributedAt: 'asc' },
      select: { id: true },
    });
    const payoutId = payout.id;
    const now = new Date();
    const closed = await this.prisma.$transaction(async (t) => {
      const db = t as unknown as PrismaClient;
      const done = await db.modReferralsPayout.updateMany({
        where: { id: payoutId, tenantId, status: 'PENDING' },
        data: { status: 'DONE', externalReference: tx.id },
      });
      if (done.count !== 1 || !referral) return false;
      await db.modReferralsCommission.create({
        data: {
          tenantId,
          referralId: referral.id,
          referrerUserId: input.userId,
          stripeInvoiceId: `credit-return:${payoutId}`,
          baseAmountCents: 0,
          amountCents,
          currency: payout!.currency,
          commissionBps: 0,
          kind: 'CREDIT_RETURN',
          status: 'APPROVED',
          approveAfter: now,
          approvedAt: now,
        },
      });
      return true;
    });
    if (closed) {
      await this.publisher.publish(tenantId, input.userId, REFERRALS_EVENT.CREDIT_RETURNED, {
        payoutId,
        referrerUserId: input.userId,
        amountCents,
        currency: payout.currency,
        stripeBalanceTransactionId: tx.id,
      });
    }
    return { returned: true, payoutId, amountCents, currency: payout.currency };
  }

  // ---------------- Cobro en dinero (datos y petición) ----------------

  /**
   * Guarda (o cambia) los datos para cobrar en dinero, cifrados. Valida el
   * formato; los errores dicen QUÉ campo falla, nunca su valor.
   */
  async savePayee(tenantId: string, userId: string, input: PayeeDetails): Promise<PayeeMaskedView> {
    const cipher = this.requireCipher();
    let details: PayeeDetails;
    try {
      details = normalizePayee(input);
    } catch (err) {
      if (err instanceof PayeeValidationError) throw new ReferralsPayeeInvalidError(err.fields);
      throw err;
    }
    if (!(await this.termsStatus(tenantId, userId)).accepted) {
      throw new ReferralsTermsRequiredError();
    }
    const enc = cipher.encrypt(JSON.stringify(details));
    const now = new Date();
    await this.prisma.modReferralsMember.update({
      where: { tenantId_userId: { tenantId, userId } },
      data: { payeeCipher: enc.cipher, payeeIv: enc.iv, payeeTag: enc.tag, payeeUpdatedAt: now },
    });
    return this.maskPayee(details, now);
  }

  /** Los datos de cobro del alumno, ENMASCARADOS (para su propia pantalla). */
  async payeeMasked(tenantId: string, userId: string): Promise<PayeeMaskedView | null> {
    const found = await this.readPayee(tenantId, userId);
    return found ? this.maskPayee(found.details, found.updatedAt) : null;
  }

  /**
   * El alumno pide el cobro en dinero de lo confirmado (APPROVED sin
   * liquidar). Hacen falta los datos de cobro y llegar al mínimo del aula. La
   * liquidación nace REQUESTED y reserva las comisiones (`payout_id`), así no
   * se pueden canjear también como descuento. A lo sumo una pedida a la vez.
   */
  async requestCashPayout(
    tenantId: string,
    userId: string,
  ): Promise<{ payoutId: string; totalCents: number; currency: string; count: number }> {
    if (!(await this.readPayee(tenantId, userId))) throw new ReferralsPayeeRequiredError();
    const open = await this.prisma.modReferralsPayout.findFirst({
      where: { tenantId, referrerUserId: userId, method: 'CASH', status: 'REQUESTED' },
      select: { id: true },
    });
    if (open) throw new ReferralsPayoutAlreadyRequestedError();
    const config = await this.getConfig(tenantId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const db = tx as unknown as PrismaClient;
        const rows = await db.modReferralsCommission.findMany({
          where: { tenantId, referrerUserId: userId, status: 'APPROVED', payoutId: null },
          orderBy: [{ approvedAt: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, amountCents: true, currency: true },
        });
        // Una sola divisa por cobro: la de la comisión positiva más antigua.
        const currency = rows.find((r) => r.amountCents > 0)?.currency;
        const picked = netAgainstAdjustments(
          rows.filter((r) => r.currency === currency),
          Number.POSITIVE_INFINITY,
        );
        const totalCents = picked.reduce((sum, r) => sum + r.amountCents, 0);
        if (!currency || totalCents <= 0) {
          throw new ReferralsPayoutValidationError('Todavía no tienes nada confirmado que cobrar.');
        }
        if (config.minPayoutCents > 0 && totalCents < config.minPayoutCents) {
          throw new ReferralsPayoutValidationError(
            `El total (${totalCents} cts) no llega al mínimo de cobro (${config.minPayoutCents} cts).`,
          );
        }
        const payout = await db.modReferralsPayout.create({
          data: {
            tenantId,
            referrerUserId: userId,
            totalCents,
            currency,
            externalReference: 'pedido',
            createdByUserId: userId,
            method: 'CASH',
            status: 'REQUESTED',
          },
        });
        const ids = picked.map((r) => r.id);
        const updated = await db.modReferralsCommission.updateMany({
          where: { id: { in: ids }, tenantId, status: 'APPROVED', payoutId: null },
          data: { payoutId: payout.id },
        });
        if (updated.count !== ids.length) {
          throw new ReferralsPayoutValidationError(
            'Lo confirmado cambió mientras lo pedías; reintenta.',
          );
        }
        return { payoutId: payout.id, totalCents, currency, count: ids.length };
      });
    } catch (err) {
      // El índice parcial «uno pedido por alumno»: dos peticiones a la vez.
      if (isUniqueViolation(err)) throw new ReferralsPayoutAlreadyRequestedError();
      throw err;
    }
  }

  /**
   * Cobros en dinero del aula para el CREADOR, con lo necesario para pagar:
   * nombre, identificador fiscal e IBAN (descifrados solo aquí).
   */
  async listCashPayouts(tenantId: string) {
    const rows = await this.prisma.modReferralsPayout.findMany({
      where: { tenantId, method: 'CASH' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const out = [];
    for (const r of rows) {
      const frozen = r.status === 'DONE' ? this.decryptSnapshot(r) : null;
      const payee = frozen ? { details: frozen } : await this.readPayee(tenantId, r.referrerUserId);
      out.push({
        receiptNumber: r.receiptNumber,
        id: r.id,
        referrerUserId: r.referrerUserId,
        totalCents: r.totalCents,
        currency: r.currency,
        status: r.status === 'REQUESTED' ? ('REQUESTED' as const) : ('DONE' as const),
        externalReference: r.status === 'REQUESTED' ? null : r.externalReference,
        requestedAt: r.createdAt,
        paidAt: r.paidAt,
        payee: payee
          ? {
              fullName: payee.details.fullName,
              country: payee.details.country,
              taxId: payee.details.taxId,
              iban: payee.details.iban,
            }
          : null,
      });
    }
    return out;
  }

  /**
   * El creador marca pagado un cobro pedido: la liquidación pasa a DONE con
   * la referencia de la transferencia y sus comisiones a PAID. Atómico.
   */
  async markCashPayoutPaid(
    tenantId: string,
    payoutId: string,
    input: { externalReference: string; actorId: string },
    now: Date = new Date(),
  ): Promise<{ payoutId: string; totalCents: number; currency: string }> {
    const reference = input.externalReference.trim();
    if (reference.length < 3) {
      throw new ReferralsPayoutValidationError(
        'La referencia del pago (transferencia…) es obligatoria.',
      );
    }
    const payout = await this.prisma.modReferralsPayout.findFirst({
      where: { id: payoutId, tenantId, method: 'CASH', status: 'REQUESTED' },
    });
    if (!payout) throw new ReferralsPayoutNotFoundError();
    const snapshot = await this.payeeSnapshot(tenantId, payout.referrerUserId);
    await this.withReceiptNumber(tenantId, async (db, receiptNumber) => {
      const closed = await db.modReferralsPayout.updateMany({
        where: { id: payoutId, tenantId, status: 'REQUESTED' },
        data: {
          status: 'DONE',
          externalReference: reference,
          paidAt: now,
          receiptNumber,
          ...snapshot,
        },
      });
      if (closed.count !== 1) throw new ReferralsPayoutNotFoundError();
      await db.modReferralsCommission.updateMany({
        where: { tenantId, payoutId, status: 'APPROVED' },
        data: { status: 'PAID' },
      });
    });
    await this.publisher.publish(tenantId, input.actorId, REFERRALS_EVENT.PAYOUT_RECORDED, {
      payoutId,
      referrerUserId: payout.referrerUserId,
      totalCents: payout.totalCents,
      currency: payout.currency,
      externalReference: reference,
      method: 'CASH',
    });
    return { payoutId, totalCents: payout.totalCents, currency: payout.currency };
  }

  /**
   * Corre `fn` en una transacción con el siguiente número de justificante del
   * aula. Dos cobros marcados a la vez chocan en el índice único
   * (tenant, número): se reintenta con el siguiente.
   */
  private async withReceiptNumber(
    tenantId: string,
    fn: (db: PrismaClient, receiptNumber: number) => Promise<void>,
  ): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const db = tx as unknown as PrismaClient;
          const last = await db.modReferralsPayout.aggregate({
            where: { tenantId },
            _max: { receiptNumber: true },
          });
          const receiptNumber = (last._max.receiptNumber ?? 0) + 1;
          await fn(db, receiptNumber);
          return receiptNumber;
        });
      } catch (err) {
        if (!isUniqueViolation(err) || attempt === 4) throw err;
      }
    }
    throw new ReferralsPayoutValidationError('No se pudo numerar el justificante; reintenta.');
  }

  /** Datos del receptor cifrados para congelarlos en el justificante (vacío si no hay). */
  private async payeeSnapshot(
    tenantId: string,
    userId: string,
  ): Promise<{
    payeeSnapshotCipher?: Buffer;
    payeeSnapshotIv?: Buffer;
    payeeSnapshotTag?: Buffer;
  }> {
    const found = await this.readPayee(tenantId, userId);
    if (!found || !this.cipher) return {};
    const enc = this.cipher.encrypt(JSON.stringify(found.details));
    return { payeeSnapshotCipher: enc.cipher, payeeSnapshotIv: enc.iv, payeeSnapshotTag: enc.tag };
  }

  private decryptSnapshot(row: {
    payeeSnapshotCipher: Uint8Array | null;
    payeeSnapshotIv: Uint8Array | null;
    payeeSnapshotTag: Uint8Array | null;
  }): PayeeDetails | null {
    if (!row.payeeSnapshotCipher || !row.payeeSnapshotIv || !row.payeeSnapshotTag || !this.cipher) {
      return null;
    }
    return JSON.parse(
      this.cipher.decrypt({
        cipher: Buffer.from(row.payeeSnapshotCipher),
        iv: Buffer.from(row.payeeSnapshotIv),
        tag: Buffer.from(row.payeeSnapshotTag),
      }),
    ) as PayeeDetails;
  }

  /**
   * Justificante en PDF de un cobro en dinero pagado. `referrerUserId` lo
   * restringe a los cobros del propio alumno (su vista); sin él, el creador
   * descarga cualquiera de su aula.
   */
  async receiptPdf(
    tenantId: string,
    payoutId: string,
    opts: { referrerUserId?: string } = {},
  ): Promise<{ filename: string; pdf: Buffer }> {
    const payout = await this.prisma.modReferralsPayout.findFirst({
      where: {
        id: payoutId,
        tenantId,
        method: 'CASH',
        status: 'DONE',
        receiptNumber: { not: null },
        ...(opts.referrerUserId ? { referrerUserId: opts.referrerUserId } : {}),
      },
    });
    if (!payout || payout.receiptNumber === null) throw new ReferralsPayoutNotFoundError();
    const [tenant, commissions, referrer] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.prisma.modReferralsCommission.findMany({
        where: { tenantId, payoutId },
        orderBy: { createdAt: 'asc' },
      }),
      // Idioma del perfil de quien cobra: con portugués, el justificante lleva
      // también el portugués (`receiptSecondLang`). Lectura del core, filtrada
      // por aula.
      this.prisma.user.findFirst({
        where: { id: payout.referrerUserId, tenantId },
        select: { locale: true },
      }),
    ]);
    const payee = this.decryptSnapshot(payout);
    const payeeLang = toReceiptLang(referrer?.locale);
    const second = receiptSecondLang(payeeLang, payee?.country);
    const lines: ReceiptLine[] = commissions.map((c) => ({
      date: c.createdAt,
      concept: receiptConcept(c, second),
      amountCents: c.amountCents,
    }));
    const pdf = await renderReceiptPdf({
      number: payout.receiptNumber,
      paidAt: payout.paidAt ?? payout.createdAt,
      reference: payout.externalReference,
      currency: payout.currency,
      totalCents: payout.totalCents,
      issuerName: tenant?.name ?? '',
      payee,
      lines,
      payeeLang,
    });
    return { filename: `justificante-${receiptLabel(payout.receiptNumber)}.pdf`, pdf };
  }

  private requireCipher(): ReferralsCipher {
    if (!this.cipher) throw new ReferralsPayeeUnavailableError();
    return this.cipher;
  }

  /** Descifra los datos de cobro del alumno (null si no los ha dado). */
  private async readPayee(
    tenantId: string,
    userId: string,
  ): Promise<{ details: PayeeDetails; updatedAt: Date | null } | null> {
    const row = await this.prisma.modReferralsMember.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { payeeCipher: true, payeeIv: true, payeeTag: true, payeeUpdatedAt: true },
    });
    if (!row?.payeeCipher || !row.payeeIv || !row.payeeTag || !this.cipher) return null;
    const plain = this.cipher.decrypt({
      cipher: Buffer.from(row.payeeCipher),
      iv: Buffer.from(row.payeeIv),
      tag: Buffer.from(row.payeeTag),
    });
    return { details: JSON.parse(plain) as PayeeDetails, updatedAt: row.payeeUpdatedAt };
  }

  private maskPayee(details: PayeeDetails, updatedAt: Date | null): PayeeMaskedView {
    return {
      fullName: details.fullName,
      country: details.country,
      taxIdMasked: maskTaxId(details.taxId),
      ibanMasked: maskIban(details.iban),
      updatedAt,
    };
  }

  // ---------------- Vistas (miembro y admin) ----------------

  /** Stats del área del miembro (/referrals). Datos reales, cero inventos. */
  async memberStats(tenantId: string, userId: string) {
    const [config, codeRow] = await Promise.all([
      this.getConfig(tenantId),
      this.prisma.modReferralsCode.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
      }),
    ]);
    const clicks = codeRow
      ? await this.prisma.modReferralsClick.count({ where: { codeId: codeRow.id } })
      : 0;
    const referrals = await this.prisma.modReferralsReferral.count({
      where: { tenantId, referrerUserId: userId },
    });
    // «Ganado» no incluye el saldo devuelto al darse de baja (ya contó al
    // ganarse); sí los ajustes por devolución, que lo restan.
    const sums = await this.prisma.modReferralsCommission.groupBy({
      by: ['status'],
      where: { tenantId, referrerUserId: userId, kind: { not: 'CREDIT_RETURN' } },
      _sum: { amountCents: true },
    });
    // Lo que puede cobrar YA (en dinero o como descuento): confirmado y sin
    // liquidar, de cualquier tipo.
    const available = await this.prisma.modReferralsCommission.aggregate({
      where: { tenantId, referrerUserId: userId, status: 'APPROVED', payoutId: null },
      _sum: { amountCents: true },
    });
    const totals = { PENDING: 0, APPROVED: 0, PAID: 0, REVOKED: 0 } as Record<string, number>;
    for (const row of sums) totals[row.status] = row._sum.amountCents ?? 0;
    const commissions = await this.prisma.modReferralsCommission.findMany({
      where: { tenantId, referrerUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const payouts = await this.prisma.modReferralsPayout.findMany({
      where: { tenantId, referrerUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const [credit, terms, payee] = await Promise.all([
      this.memberCredit(tenantId, userId, config),
      this.termsStatus(tenantId, userId),
      this.payeeMasked(tenantId, userId).catch(() => null),
    ]);
    return {
      programActive: config.active,
      terms,
      payee,
      cashPayoutAvailable: this.cipher !== null,
      memberCopy: config.memberCopy,
      commissionBps: config.commissionBps,
      scope: config.scope,
      recurringMonths: config.recurringMonths,
      minPayoutCents: config.minPayoutCents,
      attributionWindowDays: config.attributionWindowDays,
      code: codeRow?.code ?? null,
      clicks,
      referrals,
      availableCents: Math.max(0, available._sum.amountCents ?? 0),
      totals: {
        pendingCents: totals['PENDING'] ?? 0,
        approvedCents: totals['APPROVED'] ?? 0,
        paidCents: totals['PAID'] ?? 0,
      },
      commissions: commissions.map((c) => ({
        id: c.id,
        kind: c.kind as 'COMMISSION' | 'CREDIT_RETURN' | 'ADJUSTMENT',
        amountCents: c.amountCents,
        baseAmountCents: c.baseAmountCents,
        currency: c.currency,
        status: c.status,
        revokeReason: c.revokeReason,
        createdAt: c.createdAt,
      })),
      payouts: payouts.map((p) => ({
        id: p.id,
        totalCents: p.totalCents,
        currency: p.currency,
        externalReference: p.externalReference,
        method:
          p.method === 'CREDIT'
            ? ('CREDIT' as const)
            : p.method === 'CREDIT_REVERSAL'
              ? ('CREDIT_REVERSAL' as const)
              : ('CASH' as const),
        status:
          p.status === 'PENDING'
            ? ('PENDING' as const)
            : p.status === 'REQUESTED'
              ? ('REQUESTED' as const)
              : ('DONE' as const),
        paidAt: p.paidAt,
        receiptNumber: p.receiptNumber,
        createdAt: p.createdAt,
      })),
      credit,
    };
  }

  // ---------------- Canje como descuento en la cuota ----------------

  /**
   * Qué puede canjear ahora el alumno como descuento. Sin llamar a Stripe: el
   * saldo que ya tenga a favor se descuenta del tope al canjear.
   */
  private async memberCredit(
    tenantId: string,
    userId: string,
    config: ReferralsConfigView,
  ): Promise<MemberCreditView> {
    const pending = await this.prisma.modReferralsPayout.findFirst({
      where: { tenantId, referrerUserId: userId, method: 'CREDIT', status: 'PENDING' },
      select: { id: true },
    });
    const off: MemberCreditView = {
      enabled: false,
      availableCents: 0,
      currency: null,
      maxCents: 0,
      pending: pending !== null,
    };
    if (!config.allowCreditRedemption || !this.creditPort) return off;
    const sub = await this.creditSubscription(tenantId, userId);
    if (!sub) return off;
    const maxCents = creditCap(sub.unitAmount);
    const { totalCents } = await this.selectRedeemable(
      this.prisma,
      tenantId,
      userId,
      sub,
      maxCents,
    );
    return {
      enabled: maxCents > 0,
      availableCents: totalCents,
      currency: sub.currency,
      maxCents,
      pending: pending !== null,
    };
  }

  /**
   * El alumno cobra lo ganado como DESCUENTO en su próxima cuota: un abono en
   * el saldo de cliente de Stripe de su membresía.
   *
   * - Solo comisiones APPROVED (pasada la garantía) y sin liquidar, en la
   *   divisa de la cuota, hasta el tope ({@link CREDIT_MAX_SHARE_BPS}) menos
   *   lo que ya tenga a favor. Sin mínimo de liquidación: el mínimo existe por
   *   el coste de una transferencia, que aquí no hay.
   * - Idempotente: en UNA transacción la liquidación nace PENDING y las
   *   comisiones pasan a PAID con ella (dos canjes a la vez: uno gana, el otro
   *   no encuentra nada o choca con el índice de «una pendiente por alumno»).
   *   Después se abona en Stripe con la clave `referrals-credit:<id>` y la fila
   *   pasa a DONE con el `cbtxn_…`. Si Stripe falla, la fila sigue PENDING y el
   *   siguiente intento repite la MISMA llamada (misma clave, mismo importe):
   *   nunca dos abonos por el mismo saldo.
   */
  async redeemAsCredit(
    tenantId: string,
    userId: string,
  ): Promise<{
    payoutId: string;
    totalCents: number;
    currency: string;
    count: number;
    stripeBalanceTransactionId: string;
  }> {
    const config = await this.getConfig(tenantId);
    if (!config.allowCreditRedemption) throw new ReferralsCreditDisabledError();
    const port = this.creditPort;
    if (!port) throw new ReferralsCreditUnavailableError();

    // 1) Un canje a medias se termina antes de abrir otro.
    const pending = await this.prisma.modReferralsPayout.findFirst({
      where: { tenantId, referrerUserId: userId, method: 'CREDIT', status: 'PENDING' },
      include: { commissions: { select: { id: true } } },
    });
    if (pending) {
      return this.completeCredit(port, tenantId, userId, {
        payoutId: pending.id,
        customerId: pending.stripeCustomerId ?? '',
        totalCents: pending.totalCents,
        currency: pending.currency,
        count: pending.commissions.length,
      });
    }

    // 2) Membresía viva con cliente de Stripe.
    const sub = await this.creditSubscription(tenantId, userId);
    if (!sub) throw new ReferralsMembershipRequiredError();
    const cap = creditCap(sub.unitAmount);

    // 3) Lo que ya tenga a favor cuenta para el tope.
    let balance: { balanceCents: number; currency: string | null };
    try {
      balance = await port.retrieveBalance(tenantId, sub.stripeCustomerId);
    } catch {
      throw new ReferralsCreditFailedError();
    }
    if (balance.currency && balance.currency.toLowerCase() !== sub.currency) {
      throw new ReferralsCreditNothingError();
    }
    const room = cap - Math.max(0, -balance.balanceCents);
    if (room <= 0) throw new ReferralsCreditNothingError();

    // 4) Reserva atómica: liquidación PENDING + comisiones PAID.
    let reserved: { payoutId: string; totalCents: number; count: number };
    try {
      reserved = await this.prisma.$transaction(async (tx) => {
        const picked = await this.selectRedeemable(
          tx as unknown as PrismaClient,
          tenantId,
          userId,
          sub,
          room,
        );
        if (picked.ids.length === 0) throw new ReferralsCreditNothingError();
        const payout = await tx.modReferralsPayout.create({
          data: {
            tenantId,
            referrerUserId: userId,
            totalCents: picked.totalCents,
            currency: sub.currency,
            externalReference: 'pendiente',
            createdByUserId: userId,
            method: 'CREDIT',
            status: 'PENDING',
            stripeCustomerId: sub.stripeCustomerId,
          },
        });
        const updated = await tx.modReferralsCommission.updateMany({
          where: { id: { in: picked.ids }, tenantId, status: 'APPROVED', payoutId: null },
          data: { status: 'PAID', payoutId: payout.id },
        });
        if (updated.count !== picked.ids.length) {
          // Otro canje (o el admin) se llevó alguna comisión: rollback entero.
          throw new ReferralsCreditNothingError();
        }
        return { payoutId: payout.id, totalCents: picked.totalCents, count: picked.ids.length };
      });
    } catch (err) {
      // El índice parcial «una pendiente por alumno»: otro canje a la vez.
      if (isUniqueViolation(err)) throw new ReferralsCreditNothingError();
      throw err;
    }

    // 5) El abono en Stripe y el cierre.
    return this.completeCredit(port, tenantId, userId, {
      ...reserved,
      customerId: sub.stripeCustomerId,
      currency: sub.currency,
    });
  }

  private async completeCredit(
    port: ReferralsCreditPort,
    tenantId: string,
    userId: string,
    p: {
      payoutId: string;
      customerId: string;
      totalCents: number;
      currency: string;
      count: number;
    },
  ) {
    if (!p.customerId) throw new ReferralsCreditFailedError();
    let tx: { id: string };
    try {
      tx = await port.credit(tenantId, {
        customerId: p.customerId,
        amountCents: p.totalCents,
        currency: p.currency,
        // Así figura en el historial de saldo del cliente y en la factura.
        description: `${REFERRAL_CREDIT_LABEL} (${p.count} ${p.count === 1 ? 'comisión' : 'comisiones'})`,
        metadata: {
          didacta_kind: 'referral_credit',
          didacta_tenant_id: tenantId,
          didacta_referral_payout_id: p.payoutId,
        },
        idempotencyKey: creditIdempotencyKey(p.payoutId),
      });
    } catch {
      // La fila sigue PENDING: el próximo intento repite la misma llamada.
      throw new ReferralsCreditFailedError();
    }
    const closed = await this.prisma.modReferralsPayout.updateMany({
      where: { id: p.payoutId, tenantId, status: 'PENDING' },
      data: { status: 'DONE', externalReference: tx.id },
    });
    // Dos reintentos a la vez: Stripe devuelve el mismo abono a los dos y solo
    // el que cierra la fila avisa.
    if (closed.count === 1) {
      await this.publisher.publish(tenantId, userId, REFERRALS_EVENT.PAYOUT_RECORDED, {
        payoutId: p.payoutId,
        referrerUserId: userId,
        totalCents: p.totalCents,
        currency: p.currency,
        commissionCount: p.count,
        externalReference: tx.id,
        method: 'CREDIT',
      });
    }
    return {
      payoutId: p.payoutId,
      totalCents: p.totalCents,
      currency: p.currency,
      count: p.count,
      stripeBalanceTransactionId: tx.id,
    };
  }

  /**
   * Comisiones canjeables: APPROVED, sin liquidar, en la divisa de la cuota;
   * las más antiguas primero, saltando las que no caben en el tope.
   */
  private async selectRedeemable(
    db: PrismaClient,
    tenantId: string,
    userId: string,
    sub: { currency: string },
    capCents: number,
  ): Promise<{ ids: string[]; totalCents: number }> {
    const rows = await db.modReferralsCommission.findMany({
      where: {
        tenantId,
        referrerUserId: userId,
        status: 'APPROVED',
        payoutId: null,
        currency: sub.currency,
      },
      orderBy: [{ approvedAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, amountCents: true },
    });
    const picked = netAgainstAdjustments(rows, capCents);
    return {
      ids: picked.map((r) => r.id),
      totalCents: picked.reduce((sum, r) => sum + r.amountCents, 0),
    };
  }

  /**
   * La membresía viva del alumno con su cliente de Stripe (la más reciente).
   * Lectura acotada de mod_subscriptions_subscription filtrando por tenantId
   * (ADR-016, dependencia opcional declarada en el manifest).
   */
  private async creditSubscription(
    tenantId: string,
    userId: string,
  ): Promise<{ stripeCustomerId: string; currency: string; unitAmount: number } | null> {
    const sub = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: {
        tenantId,
        userId,
        planId: { not: null },
        status: { in: ['ACTIVE', 'TRIALING'] },
        stripeCustomerId: { startsWith: 'cus_' },
      },
      orderBy: { createdAt: 'desc' },
      select: { stripeCustomerId: true, currency: true, unitAmount: true },
    });
    if (!sub?.stripeCustomerId || !sub.unitAmount || sub.unitAmount <= 0) return null;
    return {
      stripeCustomerId: sub.stripeCustomerId,
      currency: sub.currency.toLowerCase(),
      unitAmount: sub.unitAmount,
    };
  }

  /**
   * «Tus invitados»: las personas que entraron con el enlace del miembro, con
   * su estado y lo que han generado. Solo los SUYOS y solo de su aula.
   *
   * Privacidad: del invitado solo salen sus iniciales; ni nombre ni correo.
   * Lecturas acotadas por `tenantId` (ADR-016: `mod.subscriptions` está
   * declarado en `optionalModules` del manifest; nunca se escribe en ella).
   */
  async memberInvitees(
    tenantId: string,
    userId: string,
  ): Promise<{
    payingNow: number;
    invitees: Array<{
      id: string;
      initials: string;
      joinedAt: Date;
      state: InviteeState;
      generatedCents: number;
      currency: string;
    }>;
  }> {
    const referrals = await this.prisma.modReferralsReferral.findMany({
      where: { tenantId, referrerUserId: userId },
      orderBy: { attributedAt: 'desc' },
      take: 200,
      select: { id: true, referredUserId: true, orderId: true, attributedAt: true },
    });
    if (referrals.length === 0) return { payingNow: 0, invitees: [] };

    const referralIds = referrals.map((r) => r.id);
    const referredIds = [...new Set(referrals.map((r) => r.referredUserId))];
    const [users, subscriptions, commissions] = await Promise.all([
      this.prisma.user.findMany({
        where: { tenantId, id: { in: referredIds } },
        select: { id: true, name: true, deletedAt: true },
      }),
      this.prisma.modSubscriptionsSubscription.findMany({
        where: { tenantId, userId: { in: referredIds }, planId: { not: null } },
        select: { userId: true, status: true, createdAt: true },
      }),
      this.prisma.modReferralsCommission.findMany({
        where: { tenantId, referrerUserId: userId, referralId: { in: referralIds } },
        select: {
          referralId: true,
          stripeInvoiceId: true,
          amountCents: true,
          currency: true,
          status: true,
        },
      }),
    ]);

    const nameBy = new Map(users.map((u) => [u.id, u.deletedAt ? null : u.name]));
    const subsBy = new Map<string, Array<{ status: string; createdAt: Date }>>();
    for (const s of subscriptions) {
      const list = subsBy.get(s.userId) ?? [];
      list.push({ status: s.status, createdAt: s.createdAt });
      subsBy.set(s.userId, list);
    }
    const commissionsBy = new Map<string, typeof commissions>();
    for (const c of commissions) {
      const list = commissionsBy.get(c.referralId) ?? [];
      list.push(c);
      commissionsBy.set(c.referralId, list);
    }

    const invitees = referrals.map((r) => {
      const all = commissionsBy.get(r.id) ?? [];
      const live = all.filter((c) => c.status !== 'REVOKED');
      // Compra suelta: comisión de pedido viva, o referido nacido de un
      // pedido que no devengó comisión (fuera de ámbito o de ventana). Si
      // todas sus comisiones de pedido están anuladas, se reembolsó.
      const orderCommissions = all.filter((c) => c.stripeInvoiceId.startsWith('order:'));
      const hasCoursePurchase =
        orderCommissions.some((c) => c.status !== 'REVOKED') ||
        (r.orderId !== null && orderCommissions.length === 0);
      return {
        id: r.id,
        initials: initialsOf(nameBy.get(r.referredUserId)),
        joinedAt: r.attributedAt,
        state: deriveInviteeState({
          subscriptions: subsBy.get(r.referredUserId) ?? [],
          hasCoursePurchase,
        }),
        generatedCents: live.reduce((sum, c) => sum + c.amountCents, 0),
        currency: live[0]?.currency ?? commissionsBy.get(r.id)?.[0]?.currency ?? 'eur',
      };
    });
    return {
      payingNow: invitees.filter((i) => i.state === 'paying').length,
      invitees,
    };
  }

  /** Listado de comisiones para el admin, con totales por estado. */
  async listCommissions(
    tenantId: string,
    filter: { status?: string; referrerUserId?: string } = {},
  ) {
    const where = {
      tenantId,
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.referrerUserId ? { referrerUserId: filter.referrerUserId } : {}),
    };
    const [rows, sums] = await Promise.all([
      this.prisma.modReferralsCommission.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.modReferralsCommission.groupBy({
        by: ['status'],
        where: { tenantId },
        _sum: { amountCents: true },
        _count: true,
      }),
    ]);
    return {
      commissions: rows,
      totalsByStatus: sums.map((s) => ({
        status: s.status,
        totalCents: s._sum.amountCents ?? 0,
        count: typeof s._count === 'number' ? s._count : 0,
      })),
    };
  }

  /** Ranking de referidores con métricas agregadas (admin). */
  async listReferrers(tenantId: string) {
    const codes = await this.prisma.modReferralsCode.findMany({
      where: { tenantId },
      include: { _count: { select: { clicks: true } } },
    });
    const referralCounts = await this.prisma.modReferralsReferral.groupBy({
      by: ['referrerUserId'],
      where: { tenantId },
      _count: true,
    });
    const commissionSums = await this.prisma.modReferralsCommission.groupBy({
      by: ['referrerUserId', 'status'],
      where: { tenantId },
      _sum: { amountCents: true },
    });
    const referralsBy = new Map<string, number>();
    for (const r of referralCounts) {
      referralsBy.set(r.referrerUserId, typeof r._count === 'number' ? r._count : 0);
    }
    const sumsBy = new Map<string, Record<string, number>>();
    for (const s of commissionSums) {
      const entry = sumsBy.get(s.referrerUserId) ?? {};
      entry[s.status] = s._sum.amountCents ?? 0;
      sumsBy.set(s.referrerUserId, entry);
    }
    return codes.map((c) => ({
      referrerUserId: c.userId,
      code: c.code,
      clicks: c._count.clicks,
      referrals: referralsBy.get(c.userId) ?? 0,
      pendingCents: sumsBy.get(c.userId)?.['PENDING'] ?? 0,
      approvedCents: sumsBy.get(c.userId)?.['APPROVED'] ?? 0,
      paidCents: sumsBy.get(c.userId)?.['PAID'] ?? 0,
    }));
  }

  // ---------------- Helpers ----------------

  /**
   * ¿Tiene el usuario una membresía viva (ACTIVE/TRIALING con planId)?
   * Lectura acotada de mod_subscriptions_subscription — dependencia opcional
   * declarada en el manifest (ADR-016), filtrando SIEMPRE por tenantId.
   */
  private async hasActiveMembership(tenantId: string, userId: string): Promise<boolean> {
    const sub = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: {
        tenantId,
        userId,
        planId: { not: null },
        status: { in: ['ACTIVE', 'TRIALING'] },
      },
      select: { id: true },
    });
    return sub !== null;
  }
}
