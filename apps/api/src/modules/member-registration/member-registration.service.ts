/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ClientContext } from '../../auth/client-context';
import { PasswordService } from '../../auth/password.service';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { membershipToBoolean, type TelegramMembership } from '@didacta/mod-member-registration';
import { buildDecisionEmail } from './email-templates';
import { resolveEmailBranding, type BrandingPrisma } from '../../common/branded-email';
import {
  fetchEmailOverride,
  type TemplateOverridePrisma,
} from '../notifications/email-template-catalog';
import { MemberDecisionService } from './member-decision.service';
import { MemberPaymentFlagService } from './member-payment-flag.service';
import { MemberRegistrationEventsService } from './member-registration-events.service';
import { MemberRegistrationSettingsService } from './member-registration-settings.service';
import type {
  MemberPurchaseMatch,
  MemberSubscriptionMatch,
  MemberSubscriptionLookupFailure,
} from '@didacta/mod-payment-connections';
import { MemberSubscriptionLookupService } from './member-subscription-lookup.service';

const DEFAULT_ALUMNO_ROLE = 'alumno';

/**
 * Type guard del error P2002 (violación de unique) de Prisma, SIN depender del
 * namespace `Prisma` de '@prisma/client': su `instanceof` no estrecha el tipo
 * en el build limpio de tsc (`nest build`) y provoca TS18046 ('e' is unknown).
 * Chequea la forma estructural `{ code: 'P2002' }`.
 */
function isUniqueConstraintViolation(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002'
  );
}

/** Datos de entrada para crear una inscripción PENDING (ya validados aguas arriba). */
export interface MemberRegistrationInput {
  name: string;
  email: string;
  password: string;
  bio?: string;
  /** null cuando la política del tenant no incluye el verificador de Telegram. */
  telegramId: string | null;
  /** Pertenencia al grupo en el momento del registro (tri-estado del API). */
  inGroup: TelegramMembership;
}

/** Resultado de la creación: si el User ya existía, `created` viene en false. */
export interface MemberRegistrationResult {
  userId: string;
  created: boolean;
  status: 'PENDING';
}

/** Una solicitud de inscripción PENDING con su lookup de suscripción (panel admin). */
export interface MemberRequestView {
  userId: string;
  name: string | null;
  email: string;
  telegramId: string | null;
  telegramInGroup: boolean | null;
  createdAt: Date;
  /** Resultado del lookup de suscripción (null si nunca se ejecutó). */
  lookup: {
    status: string;
    matchCount: number;
    results: unknown;
    /** Nº de compras puntuales (pedidos) detectadas: identifica los "lifetime". */
    purchaseCount: number;
    purchases: unknown;
    error: string | null;
    completedAt: Date | null;
    /** Email con el que se consultó (puede diferir del de registro si el admin lo mapeó). */
    email: string | null;
  } | null;
}

/**
 * Crea la inscripción de un miembro tras superar el gate (Telegram + OTP).
 *
 * El usuario se persiste en estado PENDING (sin acceso) con rol `alumno`, su
 * `telegramId` y la pertenencia al grupo capturada. Acto seguido se notifica
 * al aprobador por email con dos enlaces firmados (aprobar / rechazar), best
 * effort: si el envío falla, la inscripción NO se revierte — el admin puede
 * decidir igualmente desde el panel.
 *
 * Host NestJS de mod.member-registration (ADR-011/015): orquesta auth +
 * tenancy para el flujo de inscripción de miembros. Filtra cada query por
 * `tenantId` de forma explícita (path anónimo: el controller resuelve el
 * tenant por Host).
 */
@Injectable()
export class MemberRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly decision: MemberDecisionService,
    private readonly paymentFlags: MemberPaymentFlagService,
    private readonly settings: MemberRegistrationSettingsService,
    private readonly subscriptionLookup: MemberSubscriptionLookupService,
    private readonly smtp: SmtpAdapterService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly events: MemberRegistrationEventsService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Lista las solicitudes de inscripción PENDING del tenant junto con su lookup
   * de suscripción. Una solicitud se identifica por tener perfil de registro
   * (`mod_member_registration_profile`, creado por el flujo público y el alta
   * manual) — NO por `telegramId`, que es opcional desde los verificadores
   * componibles. Los datos de Telegram salen del perfil (fuente de verdad D13).
   * Lo consume el panel admin de solicitudes.
   */
  async listPendingRequests(tenantId: string): Promise<MemberRequestView[]> {
    const users = await this.prisma.user.findMany({
      where: { tenantId, status: 'PENDING' },
      select: { id: true, name: true, email: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    if (users.length === 0) return [];
    const profiles = await this.prisma.memberRegistrationProfile.findMany({
      where: { tenantId, userId: { in: users.map((u) => u.id) } },
      select: { userId: true, telegramId: true, telegramInGroup: true },
    });
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    const requests = users.filter((u) => profileByUser.has(u.id));
    if (requests.length === 0) return [];
    const lookups = await this.prisma.memberSubscriptionLookup.findMany({
      where: { tenantId, userId: { in: requests.map((u) => u.id) } },
    });
    const byUser = new Map(lookups.map((l) => [l.userId, l]));
    return requests.map((u) => {
      const l = byUser.get(u.id);
      const profile = profileByUser.get(u.id);
      return {
        userId: u.id,
        name: u.name,
        email: u.email,
        telegramId: profile?.telegramId ?? null,
        telegramInGroup: profile?.telegramInGroup ?? null,
        createdAt: u.createdAt,
        lookup: l
          ? {
              status: l.status,
              matchCount: l.matchCount,
              results: l.results,
              purchaseCount: l.purchaseCount,
              purchases: l.purchases,
              error: l.error,
              completedAt: l.completedAt,
              email: l.email,
            }
          : null,
      };
    });
  }

  /** Email de un usuario (para re-lanzar su lookup desde el panel). */
  async getUserEmail(tenantId: string, userId: string): Promise<string | null> {
    const u = await this.prisma.user.findFirst({
      where: { tenantId, id: userId },
      select: { email: true },
    });
    return u?.email ?? null;
  }

  /**
   * Busca-o-crea el User PENDING por (tenant, email). Idempotente: si ya existe
   * una inscripción para ese email, la devuelve sin recrear ni reenviar el email
   * al aprobador. `webBaseUrl` es la base del API (para construir los enlaces de
   * decisión que el aprobador abre).
   */
  async createPending(
    tenantId: string,
    input: MemberRegistrationInput,
    webBaseUrl: string,
    ctx: ClientContext,
    opts: { skipAutoNotify?: boolean } = {},
  ): Promise<MemberRegistrationResult> {
    // 1) Idempotencia: si ya existe el usuario para (tenant, email), no recrear.
    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: input.email } },
      select: { id: true, status: true },
    });
    if (existing) {
      return { userId: existing.id, created: false, status: 'PENDING' };
    }

    // 2) Rol por defecto + hash de la contraseña.
    const role = await this.prisma.role.findUnique({ where: { name: DEFAULT_ALUMNO_ROLE } });
    const passwordHash = await this.passwords.hash(input.password);

    // 3) Crear User PENDING + rol en una transacción. Si dos requests carreran y
    //    chocan en el índice único (tenant, email) -> P2002: tratamos como
    //    "ya existe" y devolvemos la inscripción existente.
    let user: { id: string };
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            tenantId,
            email: input.email,
            name: input.name,
            status: 'PENDING',
            passwordHash,
            bio: input.bio ?? null,
            telegramId: input.telegramId,
            telegramInGroup: membershipToBoolean(input.inGroup),
          },
          select: { id: true },
        });
        // Dual-write D13: el perfil del vertical es la fuente de verdad futura;
        // las columnas de `user` quedan deprecadas hasta D13 F4.
        await tx.memberRegistrationProfile.create({
          data: {
            id: created.id,
            tenantId,
            userId: created.id,
            telegramId: input.telegramId,
            telegramInGroup: membershipToBoolean(input.inGroup),
          },
        });
        if (role) {
          await tx.userRole.create({ data: { userId: created.id, roleId: role.id } });
        }
        return created;
      });
    } catch (e) {
      if (isUniqueConstraintViolation(e)) {
        const again = await this.prisma.user.findUnique({
          where: { tenantId_email: { tenantId, email: input.email } },
          select: { id: true },
        });
        if (again) {
          return { userId: again.id, created: false, status: 'PENDING' };
        }
      }
      throw e;
    }

    if (!role) {
      this.logger.warn(
        { tenantId, userId: user.id },
        `member-registration: rol "${DEFAULT_ALUMNO_ROLE}" no existe — usuario creado sin rol`,
      );
    }

    // 4) Audit log de la inscripción creada + evento del módulo (best-effort,
    //    declarado en el manifest — la solicitud ya quedó persistida).
    await this.auditLog.record({
      tenantId,
      actorId: user.id,
      action: 'member.inscription.created',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { telegramId: input.telegramId, inGroup: input.inGroup },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    await this.events.publish(tenantId, user.id, 'member_registration.request.created');

    // 5) En SEGUNDO PLANO (NO se hace await → no bloquea la respuesta al
    //    usuario): busca la suscripción del email en las cuentas de pago
    //    conectadas (Stripe/PayPal/WooCommerce) y LUEGO notifica al aprobador
    //    incluyendo esa suscripción en el email de validación. El path admin
    //    (createManual) lo salta para hacerlo de forma síncrona con override.
    if (!opts.skipAutoNotify) {
      void this.lookupThenNotify(tenantId, user.id, input, webBaseUrl, ctx);
    }

    return { userId: user.id, created: true, status: 'PENDING' };
  }

  /**
   * Genera los enlaces firmados de decisión y envía el email al aprobador.
   * Todo el método es best-effort: cualquier fallo se loguea como warn y NO se
   * propaga (la inscripción ya quedó persistida y debe sobrevivir).
   */
  /**
   * Corre el lookup de suscripción y luego notifica al aprobador con ella.
   * Devuelve los matches/failures. `approverOverride` permite dirigir el email de
   * validación a una dirección concreta (lo usa el alta manual/test del admin).
   */
  async lookupThenNotify(
    tenantId: string,
    userId: string,
    input: MemberRegistrationInput,
    webBaseUrl: string,
    ctx: ClientContext,
    approverOverride?: string,
  ): Promise<{
    matches: MemberSubscriptionMatch[];
    failures: MemberSubscriptionLookupFailure[];
    purchases: MemberPurchaseMatch[];
  }> {
    const { matches, failures, purchases } = await this.subscriptionLookup
      .runAndStore(tenantId, userId, input.email)
      .catch(() => ({
        matches: [] as MemberSubscriptionMatch[],
        failures: [] as MemberSubscriptionLookupFailure[],
        purchases: [] as MemberPurchaseMatch[],
      }));
    await this.notifyApprover(
      tenantId,
      userId,
      input,
      webBaseUrl,
      ctx,
      matches,
      failures,
      purchases,
      approverOverride,
    );
    return { matches, failures, purchases };
  }

  private async notifyApprover(
    tenantId: string,
    userId: string,
    input: MemberRegistrationInput,
    webBaseUrl: string,
    ctx: ClientContext,
    matches: MemberSubscriptionMatch[],
    failures: MemberSubscriptionLookupFailure[],
    purchases: MemberPurchaseMatch[],
    approverOverride?: string,
  ): Promise<void> {
    try {
      const { approveToken, rejectToken } = await this.decision.issueDecisionTokens(
        tenantId,
        userId,
        ctx,
      );
      const base = webBaseUrl.replace(/\/$/, '');
      const approveUrl = `${base}/api/v1/modules/member-registration/decision?token=${encodeURIComponent(approveToken)}`;
      const rejectUrl = `${base}/api/v1/modules/member-registration/decision?token=${encodeURIComponent(rejectToken)}`;

      // Impago por identidad: email (clave principal) con fallback a la clave
      // legacy por telegramId — funciona en todos los modos de registro.
      const flag = await this.paymentFlags.lookup(tenantId, {
        email: input.email,
        telegramId: input.telegramId,
      });
      const branding = await resolveEmailBranding(
        this.prisma as unknown as BrandingPrisma,
        tenantId,
        webBaseUrl,
      );

      // El aprobador es el override (alta manual del admin) o el del tenant
      // (setting `member-registration/approval`, con fallback a la env legacy).
      const approver =
        approverOverride?.trim() || (await this.settings.resolveApproverEmail(tenantId));
      if (!approver) {
        this.logger.warn(
          { tenantId, userId },
          'member-registration: sin aprobador (ni override ni setting ni MEMBER_APPROVAL_EMAIL) — no notificado',
        );
        return;
      }

      const resolved = await this.smtpResolver.resolve(tenantId);
      if (!resolved) {
        this.logger.warn(
          { tenantId, userId },
          'member-registration: ni tenant ni fallback global tienen SMTP — aprobador no notificado',
        );
        return;
      }

      const override = await fetchEmailOverride(
        this.prisma as unknown as TemplateOverridePrisma,
        tenantId,
        'member_registration.approval_request',
      );
      const mail = buildDecisionEmail(
        {
          name: input.name,
          email: input.email,
          telegramId: input.telegramId,
          inGroup: input.inGroup,
          isDelinquent: flag?.isDelinquent ?? false,
          approveUrl,
          rejectUrl,
          branding,
          subscriptionMatches: matches,
          subscriptionFailures: failures,
          purchases,
        },
        override,
      );
      const result = await this.smtp.send(
        resolved.config,
        { to: approver, subject: mail.subject, text: mail.text, html: mail.html },
        branding.tenantName,
      );
      if (!result.ok) {
        this.logger.warn(
          { tenantId, userId, error: result.error },
          'member-registration: fallo al enviar email de decisión al aprobador',
        );
      }
    } catch (err) {
      this.logger.warn(
        { err, tenantId, userId },
        'member-registration: excepción al notificar al aprobador',
      );
    }
  }
}
