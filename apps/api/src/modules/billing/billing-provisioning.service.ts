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
  emailGreeting,
  fetchEmailOverride,
  interpolate,
  resolveFixedEmailCopy,
  resolveRecipientLocale,
  resolveTransactionalDefault,
  toHubTemplateLang,
  type TemplateOverridePrisma,
} from '../notifications/email-template-catalog';
import { sanitizeCheckoutLocale } from '../../common/checkout-locale';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';

const DEFAULT_ALUMNO_ROLE = 'alumno';
/** El comprador puede abrir el email días después de pagar: TTL 7 días. */
const SET_PASSWORD_TTL_MINUTES = 7 * 24 * 60;
/** Key de esta bienvenida en el catálogo de plantillas del producto. */
const WELCOME_TEMPLATE_KEY = 'billing.welcome';

/**
 * Materializa al COMPRADOR ANÓNIMO de un curso suelto (checkout público de
 * mod.billing) como usuario de la plataforma.
 *
 * Réplica del patrón de la membresía (MembershipProvisioningService): usuario
 * ACTIVE con rol `alumno`, contraseña aleatoria inutilizable y email de
 * bienvenida con enlace mágico "Define tu contraseña" (single-use, TTL 7 días).
 * Vive en el host porque los módulos NO pueden escribir la tabla `user`.
 *
 * Se invoca desde el fulfillment del webhook `checkout.session.completed`, vía
 * el callback `BillingUserProvisioner` que se pasa a handleWebhookEvent.
 */
@Injectable()
export class BillingProvisioningService {
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
    /**
     * Idioma con el que el comprador estaba navegando al pagar (capturado del
     * checkout y transportado en la metadata de Stripe). Solo se escribe si el
     * usuario SE CREA aquí: a un comprador que ya existía no se le pisa la
     * preferencia que guardó en su perfil.
     */
    locale?: string;
  }): Promise<{ userId: string; created: boolean }> {
    const { tenantId, email } = args;
    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email } },
      select: { id: true },
    });
    // Comprador que YA existía: ni siquiera se mira `args.locale`. Su idioma es
    // el de su perfil y una compra no es una señal para cambiarlo.
    if (existing) return { userId: existing.id, created: false };
    const locale = sanitizeCheckoutLocale(args.locale);

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
          // CAMINO DEGRADADO NOMBRADO: sin locale capturado (visitante que
          // nunca tocó el selector, o cookie con un tag que la API no
          // persiste) se OMITE el campo y la columna toma su default de BD,
          // que es `HUB_DEFAULT_LOCALE`.
          ...(locale ? { locale } : {}),
        },
        // `locale` del comprador: es quien lee la bienvenida.
        select: { id: true, locale: true },
      });
      if (role) {
        await tx.userRole.create({ data: { userId: created.id, roleId: role.id } });
      }
      return created;
    });
    if (!role) {
      this.logger.warn(
        { tenantId, userId: user.id },
        `billing: rol "${DEFAULT_ALUMNO_ROLE}" no existe — comprador creado sin rol`,
      );
    }

    await this.auditLog.record({
      tenantId,
      actorId: user.id,
      action: 'billing.buyer_created',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email },
      ip: args.ctx.ip ?? undefined,
      userAgent: args.ctx.userAgent ?? undefined,
    });

    await this.sendWelcomeEmail(
      tenantId,
      email,
      args.name,
      args.webBaseUrl,
      args.ctx,
      resolveRecipientLocale(user.locale),
    );
    return { userId: user.id, created: true };
  }

  private async sendWelcomeEmail(
    tenantId: string,
    email: string,
    name: string | null,
    webBaseUrl: string,
    ctx: ClientContext,
    locale: string,
  ): Promise<void> {
    try {
      const resolved = await this.smtpResolver.resolve(tenantId);
      if (!resolved) {
        this.logger.warn({ tenantId }, 'billing: sin SMTP — bienvenida no enviada');
        return;
      }
      const issued = await this.passwordReset.request({ email, resolvedTenantId: tenantId }, ctx, {
        ttlMinutes: SET_PASSWORD_TTL_MINUTES,
      });
      if (!issued) {
        this.logger.warn({ tenantId }, 'billing: no se pudo emitir token de contraseña');
        return;
      }
      const base = webBaseUrl.replace(/\/$/, '');
      const setPasswordUrl = `${base}/reset-password?token=${encodeURIComponent(issued.rawToken)}`;

      const branding = await resolveEmailBranding(
        this.prisma as unknown as BrandingPrisma,
        tenantId,
        webBaseUrl,
      );
      const greeting = emailGreeting(name, locale);
      const signinUrl = `${base}/signin`;

      // Subject/cuerpo personalizables per-tenant (clave `billing.welcome`); el
      // botón «Definir mi contraseña» y la nota con la URL de acceso son
      // estructurales. El override se busca primero en el idioma del comprador
      // y, si el tenant no lo personalizó ahí, en el de referencia (misma
      // precedencia que el hub).
      const override = await fetchEmailOverride(
        this.prisma as unknown as TemplateOverridePrisma,
        tenantId,
        WELCOME_TEMPLATE_KEY,
        locale,
      );

      const vars = {
        greeting,
        name: name ?? '',
        email,
        tenantName: branding.tenantName,
        setPasswordUrl,
        signinUrl,
      };
      // Copy del catálogo para (key, idioma). Nunca `undefined`: la key existe
      // en `TRANSACTIONAL_EMAIL_DEFS` y un idioma sin traducir cae al español.
      const def = resolveTransactionalDefault(WELCOME_TEMPLATE_KEY, locale)!;
      let subject = interpolate(def.subject ?? '', vars);
      let bodyText: string;
      let bodyHtml: string;
      if (override) {
        const applied = applyEmailOverride(override, vars, subject);
        subject = applied.subject;
        bodyText = applied.bodyText;
        bodyHtml = textToHtmlParagraphs(applied.bodyText);
      } else if (toHubTemplateLang(locale) === 'en') {
        // El inglés se renderiza DESDE el catálogo (misma mecánica que un
        // override) para que composer y catálogo no puedan divergir. El español
        // conserva su maqueta HTML propia más abajo, byte a byte.
        bodyText = interpolate(def.body, vars);
        bodyHtml = textToHtmlParagraphs(bodyText);
      } else {
        bodyText = `${greeting}

¡Tu compra en ${branding.tenantName} está confirmada! Hemos creado tu cuenta y tu curso ya te espera dentro.

Para entrar, define tu contraseña con este enlace (válido 7 días):
${setPasswordUrl}

Después podrás iniciar sesión siempre desde ${base}/signin con tu email (${email}).`;
        bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>
  <p style="margin:0 0 12px;">¡Tu compra en <strong>${escapeHtml(branding.tenantName)}</strong> está confirmada! Hemos creado tu cuenta y tu curso ya te espera dentro.</p>
  <p style="margin:0 0 12px;">Para entrar, define tu contraseña (el enlace es válido 7 días):</p>`;
      }

      const { html, text } = renderBrandedEmail(branding, {
        lang: toHubTemplateLang(locale),
        title: subject,
        bodyHtml,
        bodyText,
        // Estructural: el override del tenant no puede quitar el botón ni la
        // nota, pero los dos salen en el idioma del comprador.
        cta: { label: resolveFixedEmailCopy('cta.set_my_password', locale), url: setPasswordUrl },
        footerNote: interpolate(resolveFixedEmailCopy('footer.signin_hint', locale), {
          signinUrl,
        }),
      });
      const result = await this.smtp.send(
        resolved.config,
        { to: email, subject, text, html },
        branding.tenantName,
      );
      if (!result.ok) {
        this.logger.warn({ tenantId, error: result.error }, 'billing: fallo al enviar bienvenida');
      }
    } catch (err) {
      this.logger.warn({ err, tenantId }, 'billing: excepción al enviar bienvenida');
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
