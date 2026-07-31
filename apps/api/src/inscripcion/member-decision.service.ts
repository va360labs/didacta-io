/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ClientContext } from '../auth/client-context';
import { AccessGroupsService } from '../modules/access-groups/access-groups.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { SmtpAdapterService } from '../modules/smtp-adapter.service';
import { TenantSmtpResolverService } from '../modules/tenant-smtp-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildRejectionEmail, buildWelcomeEmail } from './email-templates';
import { resolveEmailBranding, type BrandingPrisma } from '../common/branded-email';
import {
  fetchEmailOverride,
  type TemplateOverridePrisma,
} from '../modules/notifications/email-template-catalog';

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
 *     transacción y, si fue aprobado, le asigna el grupo de acceso por defecto
 *     del tenant (mod.access-groups), que materializa los enrollments. Notifica
 *     al usuario por email (best-effort).
 *
 * Es CORE del host (no un módulo): conecta inscripción + auth + enrollment.
 * Multi-tenant en path anónimo: cada query Prisma se filtra por tenantId.
 */
@Injectable()
export class MemberDecisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessGroups: AccessGroupsService,
    private readonly smtp: SmtpAdapterService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly auditLog: PrismaAuditLogService,
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
    // emails al usuario lleven el nombre/logo de su academia y no "Didacta".
    const branding = await resolveEmailBranding(
      this.prisma as unknown as BrandingPrisma,
      record.tenantId,
      process.env['WEB_PUBLIC_URL']?.trim() ?? '',
    );

    if (record.action === 'APPROVE') {
      await this.accessGroups.assignDefaultGroupOnApproval(record.tenantId, record.userId);
      const signinUrl = `${process.env['WEB_PUBLIC_URL']?.trim() ?? ''}/signin`;
      const welcomeOverride = await fetchEmailOverride(
        this.prisma as unknown as TemplateOverridePrisma,
        record.tenantId,
        'inscripcion.welcome_approved',
      );
      const { subject, text, html } = buildWelcomeEmail(
        user?.name ?? '',
        signinUrl,
        branding,
        welcomeOverride,
      );
      await this.sendEmail(
        record.tenantId,
        user?.email ?? null,
        subject,
        text,
        html,
        branding.tenantName,
      );
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

    const rejectionOverride = await fetchEmailOverride(
      this.prisma as unknown as TemplateOverridePrisma,
      record.tenantId,
      'inscripcion.rejection',
    );
    const { subject, text, html } = buildRejectionEmail(
      user?.name ?? '',
      branding,
      rejectionOverride,
    );
    await this.sendEmail(
      record.tenantId,
      user?.email ?? null,
      subject,
      text,
      html,
      branding.tenantName,
    );
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
   * Aprueba/rechaza una solicitud desde el PANEL admin (autenticado, sin token).
   * Mismo efecto que `decide`: cambia el status del usuario, sella los tokens del
   * email pendientes (para que el link del email no vuelva a decidir), asigna el
   * grupo por defecto en aprobación y notifica al usuario (best-effort).
   */
  async decideByAdmin(
    tenantId: string,
    userId: string,
    action: 'APPROVE' | 'REJECT',
    ctx: ClientContext,
  ): Promise<{ outcome: 'approved' | 'rejected' | 'invalid' }> {
    const user = await this.prisma.user.findFirst({
      where: { tenantId, id: userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) return { outcome: 'invalid' };

    const newStatus = action === 'APPROVE' ? 'ACTIVE' : 'DEACTIVATED';
    const decidedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { status: newStatus, approvalDecidedAt: decidedAt },
      });
      await tx.memberRegistrationDecisionToken.updateMany({
        where: { tenantId, userId, decidedAt: null },
        data: { decidedAt },
      });
    });

    const branding = await resolveEmailBranding(
      this.prisma as unknown as BrandingPrisma,
      tenantId,
      process.env['WEB_PUBLIC_URL']?.trim() ?? '',
    );

    if (action === 'APPROVE') {
      await this.accessGroups.assignDefaultGroupOnApproval(tenantId, userId);
      const signinUrl = `${process.env['WEB_PUBLIC_URL']?.trim() ?? ''}/signin`;
      const welcomeOverride = await fetchEmailOverride(
        this.prisma as unknown as TemplateOverridePrisma,
        tenantId,
        'inscripcion.welcome_approved',
      );
      const { subject, text, html } = buildWelcomeEmail(
        user.name ?? '',
        signinUrl,
        branding,
        welcomeOverride,
      );
      await this.sendEmail(tenantId, user.email, subject, text, html, branding.tenantName);
      await this.auditLog.record({
        tenantId,
        actorId: userId,
        action: 'member.approved',
        resourceType: 'user',
        resourceId: userId,
        metadata: { email: user.email, via: 'admin-panel' },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
      return { outcome: 'approved' };
    }

    const rejectionOverride = await fetchEmailOverride(
      this.prisma as unknown as TemplateOverridePrisma,
      tenantId,
      'inscripcion.rejection',
    );
    const { subject, text, html } = buildRejectionEmail(
      user.name ?? '',
      branding,
      rejectionOverride,
    );
    await this.sendEmail(tenantId, user.email, subject, text, html, branding.tenantName);
    await this.auditLog.record({
      tenantId,
      actorId: userId,
      action: 'member.rejected',
      resourceType: 'user',
      resourceId: userId,
      metadata: { email: user.email, via: 'admin-panel' },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return { outcome: 'rejected' };
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
    fromName?: string,
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
      const result = await this.smtp.send(resolved.config, { to, subject, text, html }, fromName);
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
