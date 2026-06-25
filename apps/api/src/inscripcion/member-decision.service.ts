import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AlreadyEnrolledError, LearningError } from '@didacta/mod-learning';
import type { ClientContext } from '../auth/client-context';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { SmtpAdapterService } from '../modules/smtp-adapter.service';
import { TenantSmtpResolverService } from '../modules/tenant-smtp-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { buildRejectionEmail, buildWelcomeEmail } from './email-templates';

/** Tokens RAW de decisión que se envían en el email del aprobador (uno por acción). */
const DECISION_ACTIONS = ['APPROVE', 'REJECT'] as const;
/** TTL de los enlaces de decisión: 7 días (en milisegundos). */
const DECISION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bytes aleatorios del token raw; el hash SHA-256 (64 hex) es lo único que se persiste. */
const TOKEN_RAW_BYTES = 32;

/**
 * Resultado de `decide`: refleja en qué estado quedó el intento de decisión.
 * - approved/rejected: la inscripción se resolvió en esta llamada.
 * - already: el token (o su inscripción) ya había sido decidido.
 * - invalid: el token no existe.
 * - expired: el token existe pero su ventana de 7 días ya pasó.
 */
export type DecisionOutcome = 'approved' | 'rejected' | 'already' | 'invalid' | 'expired';

/**
 * Gestiona la decisión del aprobador sobre una inscripción de miembro PENDING.
 *
 * Flujo:
 *  1. `issueDecisionTokens` genera DOS tokens de un solo uso (APROBAR / RECHAZAR),
 *     persistiendo SOLO su hash SHA-256. Los raw se devuelven para embeberlos en
 *     los enlaces del email del aprobador.
 *  2. `decide` consume cualquiera de los dos: cambia el status del User
 *     (ACTIVE / DEACTIVATED), sella `decidedAt` de AMBOS tokens en la misma
 *     transacción y, si fue aprobado, matricula al usuario en todos los cursos
 *     publicados del tenant. Notifica al usuario por email (best-effort).
 *
 * Es CORE del host (no un módulo): conecta inscripción + auth + enrollment.
 * Multi-tenant en path anónimo: cada query Prisma se filtra por tenantId.
 */
@Injectable()
export class MemberDecisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly smtp: SmtpAdapterService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly tenantContext: TenantContextService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Genera los dos tokens de decisión (APROBAR / RECHAZAR) para una inscripción
   * PENDING. Solo el hash SHA-256 se persiste en la BD; los raw viajan únicamente
   * en el email del aprobador. TTL de 7 días.
   */
  async issueDecisionTokens(
    tenantId: string,
    userId: string,
    ctx: ClientContext,
  ): Promise<{ approveToken: string; rejectToken: string }> {
    const expiresAt = new Date(Date.now() + DECISION_TTL_MS);
    const raws: Record<(typeof DECISION_ACTIONS)[number], string> = {
      APPROVE: '',
      REJECT: '',
    };

    for (const action of DECISION_ACTIONS) {
      const raw = randomBytes(TOKEN_RAW_BYTES).toString('hex');
      const tokenHash = this.hashToken(raw);
      raws[action] = raw;
      await this.prisma.memberRegistrationDecisionToken.create({
        data: {
          tenantId,
          userId,
          action,
          tokenHash,
          expiresAt,
          requestIp: ctx.ip ?? null,
          requestUa: ctx.userAgent ?? null,
        },
      });
    }

    return { approveToken: raws.APPROVE, rejectToken: raws.REJECT };
  }

  /**
   * Consume un token de decisión (raw) desde el email del aprobador.
   *
   * - Token inexistente → 'invalid'.
   * - Inscripción ya decidida (token con `decidedAt`) → 'already'.
   * - Token expirado (pasada la ventana de 7 días) → 'expired'.
   * - Si procede: en una transacción cambia el status del User (ACTIVE para
   *   APPROVE, DEACTIVATED para REJECT) y sella `decidedAt` de TODOS los tokens
   *   pendientes de esa inscripción. Tras la tx: si fue aprobado matricula al
   *   usuario en todos los cursos publicados y le envía la bienvenida; si fue
   *   rechazado envía el aviso de rechazo. El email es best-effort.
   */
  async decide(rawToken: string, ctx: ClientContext): Promise<{ outcome: DecisionOutcome }> {
    const tokenHash = this.hashToken(rawToken);
    const record = await this.prisma.memberRegistrationDecisionToken.findUnique({
      where: { tokenHash },
    });

    if (!record) return { outcome: 'invalid' };
    if (record.decidedAt) return { outcome: 'already' };
    if (record.expiresAt.getTime() < Date.now()) return { outcome: 'expired' };

    const newStatus = record.action === 'APPROVE' ? 'ACTIVE' : 'DEACTIVATED';
    const decidedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        data: { status: newStatus, approvalDecidedAt: decidedAt },
      });
      // Sella AMBOS tokens (el consumido y su pareja) para inutilizarlos.
      await tx.memberRegistrationDecisionToken.updateMany({
        where: { tenantId: record.tenantId, userId: record.userId, decidedAt: null },
        data: { decidedAt },
      });
    });

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      select: { email: true, name: true },
    });
    // Branding del tenant (la tabla `tenant` es global, sin RLS) para que los
    // emails al usuario lleven el nombre de su academia y no "Didacta".
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: record.tenantId },
      select: { name: true },
    });
    const tenantName = tenant?.name ?? 'Didacta';

    if (record.action === 'APPROVE') {
      await this.enrollAllPublished(record.tenantId, record.userId);
      const signinUrl = `${process.env['WEB_PUBLIC_URL']?.trim() ?? ''}/signin`;
      const { subject, text, html } = buildWelcomeEmail(user?.name ?? '', signinUrl, tenantName);
      await this.sendEmail(record.tenantId, user?.email ?? null, subject, text, html);
      await this.auditLog.record({
        tenantId: record.tenantId,
        actorId: record.userId,
        action: 'member.approved',
        resourceType: 'user',
        resourceId: record.userId,
        metadata: { email: user?.email ?? null },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
      return { outcome: 'approved' };
    }

    const { subject, text, html } = buildRejectionEmail(user?.name ?? '', tenantName);
    await this.sendEmail(record.tenantId, user?.email ?? null, subject, text, html);
    await this.auditLog.record({
      tenantId: record.tenantId,
      actorId: record.userId,
      action: 'member.rejected',
      resourceType: 'user',
      resourceId: record.userId,
      metadata: { email: user?.email ?? null },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return { outcome: 'rejected' };
  }

  /**
   * Matricula al usuario aprobado en TODOS los cursos publicados del tenant.
   * Envuelve la operación en el TenantContext porque los servicios de módulos
   * (`courses` / `learning`) leen el tenant del AsyncLocalStorage. Idempotente:
   * si ya estaba matriculado se ignora; los errores de un curso concreto
   * (`LearningError`) no abortan el resto.
   */
  private async enrollAllPublished(tenantId: string, userId: string): Promise<void> {
    await this.tenantContext.run({ tenantId, traceId: randomUUID() }, async () => {
      const courses = await this.registry
        .getCoursesService()
        .listCourses(tenantId, { status: 'PUBLISHED' });
      const learning = this.registry.getLearningService();
      for (const course of courses) {
        try {
          await learning.enrollByAdmin(tenantId, null, { userId, courseId: course.id });
        } catch (err) {
          if (err instanceof AlreadyEnrolledError) continue;
          if (err instanceof LearningError) {
            this.logger.warn(
              { tenantId, userId, courseId: course.id, code: err.code },
              'member-decision: fallo al matricular en un curso publicado — se omite',
            );
            continue;
          }
          throw err;
        }
      }
    });
  }

  /**
   * Envío best-effort del email al usuario (bienvenida o rechazo). Si el tenant
   * no tiene SMTP, falta el destinatario o el envío falla, se loguea y se sigue:
   * la decisión ya quedó persistida y no debe revertirse por un fallo de correo.
   */
  private async sendEmail(
    tenantId: string,
    to: string | null,
    subject: string,
    text: string,
    html: string,
  ): Promise<void> {
    if (!to) {
      this.logger.warn(
        { tenantId },
        'member-decision: usuario sin email — notificación no enviada',
      );
      return;
    }
    try {
      const resolved = await this.smtpResolver.resolve(tenantId);
      if (!resolved) {
        this.logger.warn(
          { tenantId },
          'member-decision: ni tenant ni fallback global tienen SMTP — email no enviado',
        );
        return;
      }
      const result = await this.smtp.send(resolved.config, { to, subject, text, html });
      if (!result.ok) {
        this.logger.warn(
          { tenantId, error: result.error },
          'member-decision: fallo al enviar email de decisión',
        );
      }
    } catch (err) {
      this.logger.warn({ err, tenantId }, 'member-decision: excepción al enviar email de decisión');
    }
  }

  /** SHA-256 hex del token raw — formato consistente con la columna VARCHAR(64). */
  private hashToken(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }
}
