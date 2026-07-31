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
  ReferralsMembershipRequiredError,
  ReferralsPayoutValidationError,
  ReferralsProgramInactiveError,
} from './errors.js';

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

export const REFERRALS_EVENT = {
  ATTRIBUTED: 'referrals.referral.attributed',
  COMMISSION_CREATED: 'referrals.commission.created',
  COMMISSION_APPROVED: 'referrals.commission.approved',
  COMMISSION_REVOKED: 'referrals.commission.revoked',
  PAYOUT_RECORDED: 'referrals.payout.recorded',
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
}

const DEFAULT_CONFIG: ReferralsConfigView = {
  active: false,
  commissionBps: 3000,
  scope: 'RECURRING',
  recurringMonths: null,
  attributionWindowDays: 30,
  guaranteeDays: 14,
  minPayoutCents: 5000,
  requireActiveMembership: true,
  memberCopy: null,
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
      reason: 'program_inactive' | 'code_not_found' | 'self_referral' | 'already_attributed';
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
    };
    await this.prisma.modReferralsConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...next },
      update: next,
    });
    return next;
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
   * Registra un clic de /unete?ref=CODE. Best-effort silencioso: código
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
    if (codeRow.userId === input.referredUserId) {
      return { attributed: false, reason: 'self_referral' };
    }
    const [referrerEmail, referredEmail] = await Promise.all([
      this.getUserEmail(input.tenantId, codeRow.userId),
      this.getUserEmail(input.tenantId, input.referredUserId),
    ]);
    const a = normalizeEmail(referrerEmail);
    const b = normalizeEmail(referredEmail);
    if (a !== null && a === b) {
      return { attributed: false, reason: 'self_referral' };
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
   * PENDING → APPROVED para todas las comisiones cuya garantía venció.
   * Lo invoca el worker (cron horario). Devuelve cuántas aprobó.
   */
  async approveDueCommissions(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.modReferralsCommission.findMany({
      where: { status: 'PENDING', approveAfter: { lte: now } },
      take: 500,
    });
    let approved = 0;
    for (const commission of due) {
      const result = await this.prisma.modReferralsCommission.updateMany({
        where: { id: commission.id, status: 'PENDING' },
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
   * Revocación AUTOMÁTICA por reembolso del cobro origen (evento
   * `subscriptions.invoice.refunded`). No lanza: el bridge loguea el
   * resultado. Una comisión ya PAGADA no se toca (clawback = decisión
   * manual del operador); el caso queda señalado para revisión.
   */
  async revokeCommissionByInvoice(
    tenantId: string,
    stripeInvoiceId: string,
    reason: string,
  ): Promise<
    | { revoked: true; commissionId: string }
    | { revoked: false; reason: 'not_found' | 'already_revoked' | 'already_paid' }
  > {
    const commission = await this.prisma.modReferralsCommission.findUnique({
      where: { stripeInvoiceId },
    });
    if (!commission || commission.tenantId !== tenantId) {
      return { revoked: false, reason: 'not_found' };
    }
    if (commission.status === 'REVOKED') return { revoked: false, reason: 'already_revoked' };
    if (commission.status === 'PAID') return { revoked: false, reason: 'already_paid' };

    // Optimista: solo revoca si sigue PENDING/APPROVED (carrera con payout).
    const updated = await this.prisma.modReferralsCommission.updateMany({
      where: { id: commission.id, status: { in: ['PENDING', 'APPROVED'] } },
      data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason },
    });
    if (updated.count === 0) return { revoked: false, reason: 'already_paid' };

    await this.publisher.publish(tenantId, null, REFERRALS_EVENT.COMMISSION_REVOKED, {
      commissionId: commission.id,
      referrerUserId: commission.referrerUserId,
      reason,
    });
    return { revoked: true, commissionId: commission.id };
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
    const totalCents = commissions.reduce((sum, c) => sum + c.amountCents, 0);

    const config = await this.getConfig(tenantId);
    if (config.minPayoutCents > 0 && totalCents < config.minPayoutCents) {
      throw new ReferralsPayoutValidationError(
        `El total (${totalCents} cts) no llega al mínimo de liquidación (${config.minPayoutCents} cts).`,
      );
    }

    const payoutId = await this.prisma.$transaction(async (tx) => {
      const payout = await tx.modReferralsPayout.create({
        data: {
          tenantId,
          referrerUserId: input.referrerUserId,
          totalCents,
          currency,
          externalReference: input.externalReference.trim(),
          createdByUserId: input.createdByUserId,
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
      return payout.id;
    });

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

  // ---------------- Vistas (miembro y admin) ----------------

  /** Stats del área del miembro (/referidos). Datos reales, cero inventos. */
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
    const sums = await this.prisma.modReferralsCommission.groupBy({
      by: ['status'],
      where: { tenantId, referrerUserId: userId },
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
    return {
      programActive: config.active,
      memberCopy: config.memberCopy,
      commissionBps: config.commissionBps,
      scope: config.scope,
      recurringMonths: config.recurringMonths,
      minPayoutCents: config.minPayoutCents,
      attributionWindowDays: config.attributionWindowDays,
      code: codeRow?.code ?? null,
      clicks,
      referrals,
      totals: {
        pendingCents: totals['PENDING'] ?? 0,
        approvedCents: totals['APPROVED'] ?? 0,
        paidCents: totals['PAID'] ?? 0,
      },
      commissions: commissions.map((c) => ({
        id: c.id,
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
        createdAt: p.createdAt,
      })),
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
