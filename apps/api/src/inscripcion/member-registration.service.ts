import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ClientContext } from '../auth/client-context';
import { PasswordService } from '../auth/password.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { SmtpAdapterService } from '../modules/smtp-adapter.service';
import { TenantSmtpResolverService } from '../modules/tenant-smtp-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { membershipToBoolean, type TelegramMembership } from './inscripcion.dto';
import { buildDecisionEmail } from './email-templates';
import { MemberDecisionService } from './member-decision.service';
import { MemberPaymentFlagService } from './member-payment-flag.service';
import type {
  MemberSubscriptionMatch,
  MemberSubscriptionLookupFailure,
} from '@didacta/mod-payment-connections';
import { MemberSubscriptionLookupService } from './member-subscription-lookup.service';

const DEFAULT_ALUMNO_ROLE = 'alumno';
const DEFAULT_TENANT_NAME = 'Didacta';

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
  telegramId: string;
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
 * Es CORE del host (no un módulo): orquesta auth + tenancy para el flujo de
 * inscripción de miembros. Ver PRD Notion. Filtra cada query por `tenantId`
 * de forma explícita (path anónimo: el controller resuelve el tenant por Host).
 */
@Injectable()
export class MemberRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly decision: MemberDecisionService,
    private readonly paymentFlags: MemberPaymentFlagService,
    private readonly subscriptionLookup: MemberSubscriptionLookupService,
    private readonly smtp: SmtpAdapterService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Lista las solicitudes de inscripción PENDING del tenant (miembros que se
   * registraron por `/inscripcion-miembros`, identificados por tener `telegramId`)
   * junto con su lookup de suscripción. Lo consume el panel admin de solicitudes.
   */
  async listPendingRequests(tenantId: string): Promise<MemberRequestView[]> {
    const users = await this.prisma.user.findMany({
      where: { tenantId, status: 'PENDING', telegramId: { not: null } },
      select: {
        id: true,
        name: true,
        email: true,
        telegramId: true,
        telegramInGroup: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    if (users.length === 0) return [];
    const lookups = await this.prisma.memberSubscriptionLookup.findMany({
      where: { tenantId, userId: { in: users.map((u) => u.id) } },
    });
    const byUser = new Map(lookups.map((l) => [l.userId, l]));
    return users.map((u) => {
      const l = byUser.get(u.id);
      return {
        userId: u.id,
        name: u.name,
        email: u.email,
        telegramId: u.telegramId,
        telegramInGroup: u.telegramInGroup,
        createdAt: u.createdAt,
        lookup: l
          ? {
              status: l.status,
              matchCount: l.matchCount,
              results: l.results,
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

    // 4) Audit log de la inscripción creada.
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
  ): Promise<{ matches: MemberSubscriptionMatch[]; failures: MemberSubscriptionLookupFailure[] }> {
    const { matches, failures } = await this.subscriptionLookup
      .runAndStore(tenantId, userId, input.email)
      .catch(() => ({
        matches: [] as MemberSubscriptionMatch[],
        failures: [] as MemberSubscriptionLookupFailure[],
      }));
    await this.notifyApprover(
      tenantId,
      userId,
      input,
      webBaseUrl,
      ctx,
      matches,
      failures,
      approverOverride,
    );
    return { matches, failures };
  }

  private async notifyApprover(
    tenantId: string,
    userId: string,
    input: MemberRegistrationInput,
    webBaseUrl: string,
    ctx: ClientContext,
    matches: MemberSubscriptionMatch[],
    failures: MemberSubscriptionLookupFailure[],
    approverOverride?: string,
  ): Promise<void> {
    try {
      const { approveToken, rejectToken } = await this.decision.issueDecisionTokens(
        tenantId,
        userId,
        ctx,
      );
      const base = webBaseUrl.replace(/\/$/, '');
      const approveUrl = `${base}/api/v1/inscripcion/decision?token=${encodeURIComponent(approveToken)}`;
      const rejectUrl = `${base}/api/v1/inscripcion/decision?token=${encodeURIComponent(rejectToken)}`;

      const flag = await this.paymentFlags.lookup(tenantId, input.telegramId);
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      const tenantName = tenant?.name ?? DEFAULT_TENANT_NAME;

      // El aprobador es el override (alta manual del admin) o el de la env.
      const approver = approverOverride?.trim() || process.env['MEMBER_APPROVAL_EMAIL']?.trim();
      if (!approver) {
        this.logger.warn(
          { tenantId, userId },
          'member-registration: sin aprobador (ni override ni MEMBER_APPROVAL_EMAIL) — no notificado',
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

      const mail = buildDecisionEmail({
        name: input.name,
        email: input.email,
        telegramId: input.telegramId,
        inGroup: input.inGroup,
        isDelinquent: flag?.isDelinquent ?? false,
        approveUrl,
        rejectUrl,
        tenantName,
        subscriptionMatches: matches,
        subscriptionFailures: failures,
      });
      const result = await this.smtp.send(resolved.config, {
        to: approver,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
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
