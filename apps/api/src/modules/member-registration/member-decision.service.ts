/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ClientContext } from '../../auth/client-context';
import { AccessGroupsService } from '../access-groups/access-groups.service';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { buildRejectionEmail, buildWelcomeEmail } from './email-templates';
import { resolveEmailBranding, type BrandingPrisma } from '../../common/branded-email';
import {
  fetchEmailOverride,
  resolveRecipientLocale,
  type TemplateOverridePrisma,
} from '../notifications/email-template-catalog';
import { MemberRegistrationEventsService } from './member-registration-events.service';

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
 * Host NestJS de mod.member-registration (ADR-011/015): conecta inscripción +
 * auth + enrollment (grupo por defecto vía el vertical de access-groups).
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
    private readonly events: MemberRegistrationEventsService,
    private readonly logger: PinoLogger,
    private readonly tenantResolver: TenantResolverService,
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
   * Mira qué haría el token SIN hacerlo. Es lo que consulta la pantalla de
   * confirmación antes de que el aprobador pulse el botón.
   *
   * Existe porque el email lleva dos enlaces (APROBAR y RECHAZAR) y esos
   * enlaces los abre cualquier escáner de correo corporativo —Outlook
   * SafeLinks, Mimecast, Proofpoint hacen GET a todos los enlaces de un
   * mensaje—. Con la decisión colgando de un GET, el robot decidía la
   * inscripción antes de que el humano abriera el correo, y el desenlace
   * dependía de cuál de los dos enlaces visitara primero. Ahora el GET solo
   * lee: mutar exige el POST que dispara el botón.
   */
  async previewDecision(rawToken: string): Promise<{
    outcome: 'confirm' | 'already' | 'invalid' | 'expired';
    action: 'APPROVE' | 'REJECT' | null;
    memberName: string | null;
    tenantId: string | null;
  }> {
    const record = await this.prisma.memberRegistrationDecisionToken.findUnique({
      where: { tokenHash: this.hashToken(rawToken) },
    });
    if (!record) return { outcome: 'invalid', action: null, memberName: null, tenantId: null };
    if (record.decidedAt) {
      return {
        outcome: 'already',
        action: record.action,
        memberName: null,
        tenantId: record.tenantId,
      };
    }
    if (record.expiresAt.getTime() < Date.now()) {
      return {
        outcome: 'expired',
        action: record.action,
        memberName: null,
        tenantId: record.tenantId,
      };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      select: { name: true, email: true },
    });
    return {
      outcome: 'confirm',
      action: record.action,
      memberName: user?.name ?? user?.email ?? null,
      tenantId: record.tenantId,
    };
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
  async decide(
    rawToken: string,
    ctx: ClientContext,
  ): Promise<{ outcome: DecisionOutcome; tenantId: string | null }> {
    const tokenHash = this.hashToken(rawToken);
    const record = await this.prisma.memberRegistrationDecisionToken.findUnique({
      where: { tokenHash },
    });

    if (!record) return { outcome: 'invalid', tenantId: null };
    if (record.decidedAt) return { outcome: 'already', tenantId: record.tenantId };
    if (record.expiresAt.getTime() < Date.now()) {
      return { outcome: 'expired', tenantId: record.tenantId };
    }

    const newStatus = record.action === 'APPROVE' ? 'ACTIVE' : 'DEACTIVATED';
    const decidedAt = new Date();

    // El `decidedAt` se comprobó arriba, FUERA de la transacción: dos
    // peticiones simultáneas (los dos enlaces del correo abiertos a la vez, o
    // un doble clic) pasaban las dos el chequeo y las dos escribían. El sellado
    // es ahora lo primero de la transacción y lleva `decidedAt: null` en el
    // `where`: quien no selle ninguna fila es que llegó segundo y se retira.
    let gano = true;
    await this.prisma.$transaction(async (tx) => {
      const sellados = await tx.memberRegistrationDecisionToken.updateMany({
        where: { tenantId: record.tenantId, userId: record.userId, decidedAt: null },
        data: { decidedAt },
      });
      if (sellados.count === 0) {
        gano = false;
        return;
      }
      await tx.user.update({
        where: { id: record.userId },
        data: { status: newStatus, approvalDecidedAt: decidedAt },
      });
      // Dual-write D13: sella también el perfil del vertical (0 filas si el
      // usuario no tiene perfil, p.ej. altas previas sin flujo de registro).
      await tx.memberRegistrationProfile.updateMany({
        where: { tenantId: record.tenantId, userId: record.userId },
        data: { approvalDecidedAt: decidedAt },
      });
    });

    // Llegó segundo: la decisión ya la tomó la otra petición.
    if (!gano) return { outcome: 'already', tenantId: record.tenantId };

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      // `locale` = idioma del MIEMBRO: es él quien lee la aprobación/rechazo.
      select: { email: true, name: true, locale: true },
    });
    // Sin `req` (este service no ve el HTTP request): cascada env → dominio
    // primario verificado del tenant → localhost. Antes leía WEB_PUBLIC_URL
    // directo — con la env sin set, el link salía roto (`""` + `/signin`).
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(record.tenantId);
    // Branding del tenant (la tabla `tenant` es global, sin RLS) para que los
    // emails al usuario lleven el nombre/logo de su academia y no "Didacta".
    const branding = await resolveEmailBranding(
      this.prisma as unknown as BrandingPrisma,
      record.tenantId,
      webBaseUrl,
    );

    if (record.action === 'APPROVE') {
      await this.accessGroups.assignDefaultGroupOnApproval(record.tenantId, record.userId);
      const signinUrl = `${webBaseUrl}/signin`;
      const welcomeOverride = await fetchEmailOverride(
        this.prisma as unknown as TemplateOverridePrisma,
        record.tenantId,
        'member_registration.welcome_approved',
        resolveRecipientLocale(user?.locale),
      );
      const { subject, text, html } = buildWelcomeEmail(
        user?.name ?? '',
        signinUrl,
        branding,
        resolveRecipientLocale(user?.locale),
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
      await this.events.publish(
        record.tenantId,
        record.userId,
        'member_registration.request.approved',
        {
          via: 'email',
        },
      );
      return { outcome: 'approved', tenantId: record.tenantId };
    }

    const rejectionOverride = await fetchEmailOverride(
      this.prisma as unknown as TemplateOverridePrisma,
      record.tenantId,
      'member_registration.rejection',
      resolveRecipientLocale(user?.locale),
    );
    const { subject, text, html } = buildRejectionEmail(
      user?.name ?? '',
      branding,
      resolveRecipientLocale(user?.locale),
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
    await this.events.publish(
      record.tenantId,
      record.userId,
      'member_registration.request.rejected',
      {
        via: 'email',
      },
    );
    return { outcome: 'rejected', tenantId: record.tenantId };
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
      select: { id: true, email: true, name: true, locale: true },
    });
    if (!user) return { outcome: 'invalid' };

    const newStatus = action === 'APPROVE' ? 'ACTIVE' : 'DEACTIVATED';
    const decidedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { status: newStatus, approvalDecidedAt: decidedAt },
      });
      // Dual-write D13: sella también el perfil del vertical (0 filas si no hay).
      await tx.memberRegistrationProfile.updateMany({
        where: { tenantId, userId },
        data: { approvalDecidedAt: decidedAt },
      });
      await tx.memberRegistrationDecisionToken.updateMany({
        where: { tenantId, userId, decidedAt: null },
        data: { decidedAt },
      });
    });

    // Sin `req` (llamada desde el panel admin, no un handler HTTP con Host):
    // cascada env → dominio primario verificado del tenant → localhost.
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(tenantId);
    const branding = await resolveEmailBranding(
      this.prisma as unknown as BrandingPrisma,
      tenantId,
      webBaseUrl,
    );

    if (action === 'APPROVE') {
      await this.accessGroups.assignDefaultGroupOnApproval(tenantId, userId);
      const signinUrl = `${webBaseUrl}/signin`;
      const welcomeOverride = await fetchEmailOverride(
        this.prisma as unknown as TemplateOverridePrisma,
        tenantId,
        'member_registration.welcome_approved',
        resolveRecipientLocale(user.locale),
      );
      const { subject, text, html } = buildWelcomeEmail(
        user.name ?? '',
        signinUrl,
        branding,
        resolveRecipientLocale(user.locale),
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
      await this.events.publish(tenantId, userId, 'member_registration.request.approved', {
        via: 'admin-panel',
      });
      return { outcome: 'approved' };
    }

    const rejectionOverride = await fetchEmailOverride(
      this.prisma as unknown as TemplateOverridePrisma,
      tenantId,
      'member_registration.rejection',
      resolveRecipientLocale(user.locale),
    );
    const { subject, text, html } = buildRejectionEmail(
      user.name ?? '',
      branding,
      resolveRecipientLocale(user.locale),
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
    await this.events.publish(tenantId, userId, 'member_registration.request.rejected', {
      via: 'admin-panel',
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
