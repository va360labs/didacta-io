/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ClientContext } from '../../auth/client-context';
import { PasswordService } from '../../auth/password.service';
import { PasswordResetService } from '../../auth/password-reset.service';
import {
  resolveEmailBranding,
  renderBrandedEmail,
  textToHtmlParagraphs,
  type BrandingPrisma,
} from '../../common/branded-email';
import {
  applyEmailOverride,
  fetchEmailOverride,
  type TemplateOverridePrisma,
} from '../notifications/email-template-catalog';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';

const DEFAULT_ALUMNO_ROLE = 'alumno';
/** El comprador puede abrir el email días después de pagar: TTL 7 días. */
const SET_PASSWORD_TTL_MINUTES = 7 * 24 * 60;

/**
 * Materializa al COMPRADOR de la membresía como usuario de la plataforma.
 *
 * Mismo patrón que el alta por API (InscribeService.findOrCreateUser): usuario
 * ACTIVE con rol `alumno`, contraseña aleatoria inutilizable y email de
 * bienvenida con enlace mágico "Define tu contraseña" (single-use, TTL 7 días).
 * Vive en el host porque los módulos NO pueden escribir la tabla `user`.
 *
 * Se invoca desde el webhook `checkout.session.completed` (fulfillment), vía el
 * callback `UserProvisioner` que se pasa a MembershipService.
 */
@Injectable()
export class MembershipProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly passwordReset: PasswordResetService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly smtp: SmtpAdapterService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Busca el usuario por (tenant, email); si no existe lo crea. Si lo crea,
   * envía el email de bienvenida (best-effort — un fallo de SMTP nunca tumba
   * el webhook: el comprador siempre puede usar "¿olvidaste tu contraseña?").
   */
  async provision(args: {
    tenantId: string;
    email: string;
    name: string | null;
    webBaseUrl: string;
    ctx: ClientContext;
  }): Promise<{ userId: string; created: boolean }> {
    const { tenantId, email } = args;
    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email } },
      select: { id: true },
    });
    if (existing) return { userId: existing.id, created: false };

    const passwordHash = await this.passwords.hash(randomBytes(16).toString('base64url'));
    const role = await this.prisma.role.findUnique({ where: { name: DEFAULT_ALUMNO_ROLE } });

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId,
          email,
          name: args.name,
          status: 'ACTIVE',
          passwordHash,
          // El comprador define su contraseña con el enlace mágico; forzar
          // además el cambio le obligaría a un segundo login.
          mustChangePassword: false,
        },
        select: { id: true },
      });
      if (role) {
        await tx.userRole.create({ data: { userId: created.id, roleId: role.id } });
      }
      return created;
    });
    if (!role) {
      this.logger.warn(
        { tenantId, userId: user.id },
        `membership: rol "${DEFAULT_ALUMNO_ROLE}" no existe — comprador creado sin rol`,
      );
    }

    await this.auditLog.record({
      tenantId,
      actorId: user.id,
      action: 'membership.buyer_created',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email },
      ip: args.ctx.ip ?? undefined,
      userAgent: args.ctx.userAgent ?? undefined,
    });

    await this.sendWelcomeEmail(tenantId, email, args.name, args.webBaseUrl, args.ctx);
    return { userId: user.id, created: true };
  }

  private async sendWelcomeEmail(
    tenantId: string,
    email: string,
    name: string | null,
    webBaseUrl: string,
    ctx: ClientContext,
  ): Promise<void> {
    try {
      const resolved = await this.smtpResolver.resolve(tenantId);
      if (!resolved) {
        this.logger.warn({ tenantId }, 'membership: sin SMTP — bienvenida no enviada');
        return;
      }
      const issued = await this.passwordReset.request({ email, resolvedTenantId: tenantId }, ctx, {
        ttlMinutes: SET_PASSWORD_TTL_MINUTES,
      });
      if (!issued) {
        this.logger.warn({ tenantId }, 'membership: no se pudo emitir token de contraseña');
        return;
      }
      const base = webBaseUrl.replace(/\/$/, '');
      const setPasswordUrl = `${base}/reset-password?token=${encodeURIComponent(issued.rawToken)}`;

      const branding = await resolveEmailBranding(
        this.prisma as unknown as BrandingPrisma,
        tenantId,
        webBaseUrl,
      );
      const greeting = name ? `Hola ${name},` : 'Hola,';

      // alpha.83 — subject/cuerpo personalizables per-tenant; el botón «Definir
      // mi contraseña» y la nota con la URL de acceso son estructurales.
      const override = await fetchEmailOverride(
        this.prisma as unknown as TemplateOverridePrisma,
        tenantId,
        'membership.welcome',
      );

      let subject = `Tu membresía en ${branding.tenantName}`;
      let bodyText: string;
      let bodyHtml: string;
      if (override) {
        const applied = applyEmailOverride(
          override,
          {
            greeting,
            name: name ?? '',
            email,
            tenantName: branding.tenantName,
            setPasswordUrl,
            signinUrl: `${base}/signin`,
          },
          subject,
        );
        subject = applied.subject;
        bodyText = applied.bodyText;
        bodyHtml = textToHtmlParagraphs(applied.bodyText);
      } else {
        bodyText = `${greeting}

¡Tu membresía en ${branding.tenantName} está activa! Ya tienes acceso a todos los cursos incluidos.

Para entrar, define tu contraseña con este enlace (válido 7 días):
${setPasswordUrl}

Después podrás iniciar sesión siempre desde ${base}/signin con tu email (${email}).`;
        bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>
  <p style="margin:0 0 12px;">¡Tu membresía en <strong>${escapeHtml(branding.tenantName)}</strong> está activa! Ya tienes acceso a todos los cursos incluidos.</p>
  <p style="margin:0 0 12px;">Para entrar, define tu contraseña (el enlace es válido 7 días):</p>`;
      }

      const { html, text } = renderBrandedEmail(branding, {
        title: subject,
        bodyHtml,
        bodyText,
        cta: { label: 'Definir mi contraseña', url: setPasswordUrl },
        footerNote: `Después podrás iniciar sesión desde ${base}/signin con tu email.`,
      });
      const result = await this.smtp.send(
        resolved.config,
        { to: email, subject, text, html },
        branding.tenantName,
      );
      if (!result.ok) {
        this.logger.warn(
          { tenantId, error: result.error },
          'membership: fallo al enviar bienvenida',
        );
      }
    } catch (err) {
      this.logger.warn({ err, tenantId }, 'membership: excepción al enviar bienvenida');
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
