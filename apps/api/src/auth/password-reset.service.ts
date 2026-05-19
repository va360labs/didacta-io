import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../modules/prisma-tenant-config.service';
import { SmtpAdapterService } from '../modules/smtp-adapter.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ClientContext } from './client-context';
import { PasswordService } from './password.service';

const TOKEN_TTL_MINUTES = 60;
const TOKEN_RAW_BYTES = 32;

const NO_CLIENT_CONTEXT: ClientContext = { ip: null, userAgent: null };

/**
 * Servicio de "olvidé mi contraseña".
 *
 * Decisiones de seguridad:
 * - El token raw (32 bytes random hex) viaja SOLO en email.
 * - La DB persiste SHA-256 del token: imposible recuperar el original ni
 *   con dump completo de la base.
 * - Single-use: al consumir se marca `usedAt` y futuros intentos fallan.
 * - TTL 60 minutos. Más allá se rechaza con código específico.
 * - `request()` siempre devuelve el mismo response (200 sin info) para no
 *   leakear si el email existe (user enumeration attack).
 * - Se invalidan tokens previos del mismo user al pedir uno nuevo.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly smtp: SmtpAdapterService,
    private readonly tenantConfig: PrismaTenantConfigService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Genera un token de reset, lo persiste hasheado y devuelve el token raw
   * (que el caller debe enviar por email — esta función NO envía emails).
   *
   * Si el usuario no existe o está inactivo, devuelve `null` SIN throw para
   * que el endpoint pueda responder genérico (anti user enumeration).
   *
   * Por defecto solo acepta usuarios ACTIVE (path público `/auth/forgot-password`,
   * defensa anti-enum). Los call sites admin-triggered (invite / resendInvite)
   * pasan `opts.allowPending = true` para poder enviar el email de "definí
   * tu contraseña" a usuarios que están justo en status PENDING porque acaban
   * de ser invitados. Ver CORE-FIX-03.
   */
  async request(
    args: { email: string; tenantSlug?: string; resolvedTenantId?: string },
    ctx: ClientContext = NO_CLIENT_CONTEXT,
    opts: { allowPending?: boolean } = {},
  ): Promise<{
    rawToken: string;
    userId: string;
    userName: string | null;
    tenantId: string;
  } | null> {
    const tenant = await this.resolveTenant(args);
    if (!tenant) return null;

    const user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: args.email } },
    });
    const allowedStatuses = opts.allowPending
      ? new Set(['ACTIVE', 'PENDING'])
      : new Set(['ACTIVE']);
    if (!user || !allowedStatuses.has(user.status)) return null;

    // Invalidar tokens previos no usados — limita el blast radius si un
    // atacante pudiese tomar el primer email.
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });

    const rawToken = randomBytes(TOKEN_RAW_BYTES).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tenantId: tenant.id,
        tokenHash,
        expiresAt,
        requestIp: ctx.ip ?? null,
        requestUa: ctx.userAgent ?? null,
      },
    });

    await this.auditLog.record({
      tenantId: tenant.id,
      actorId: user.id,
      action: 'auth.password_reset.requested',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email: user.email, expiresAt: expiresAt.toISOString() },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return { rawToken, userId: user.id, userName: user.name, tenantId: tenant.id };
  }

  /**
   * Consume un token, valida no expirado y no usado, hashea la nueva
   * contraseña y la persiste. Marca el token como usado.
   */
  async reset(
    rawToken: string,
    newPassword: string,
    ctx: ClientContext = NO_CLIENT_CONTEXT,
  ): Promise<void> {
    const tokenHash = this.hashToken(rawToken);
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (!record) {
      throw new UnauthorizedException('Token inválido o ya utilizado.');
    }
    if (record.usedAt) {
      throw new UnauthorizedException('Este enlace ya fue usado. Pedí uno nuevo.');
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Este enlace expiró. Pedí uno nuevo.');
    }

    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    await this.auditLog.record({
      tenantId: record.tenantId,
      actorId: record.userId,
      action: 'auth.password_reset.completed',
      resourceType: 'user',
      resourceId: record.userId,
      metadata: { tokenId: record.id },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
  }

  /**
   * End-to-end del flujo "forgot": genera token + envía email vía SMTP
   * per-tenant. Envuelto en try/catch — si falla SMTP, el endpoint igual
   * responde 200 (anti user-enumeration). El detalle queda en logs.
   */
  async requestAndSendEmail(
    args: { email: string; tenantSlug?: string; resolvedTenantId?: string },
    webBaseUrl: string,
    ctx: ClientContext = NO_CLIENT_CONTEXT,
    opts: { allowPending?: boolean } = {},
  ): Promise<void> {
    const result = await this.request(args, ctx, opts);
    if (!result) return;

    let smtpRaw: unknown;
    try {
      smtpRaw = await this.tenantConfig.get(result.tenantId, 'notifications', 'smtp');
    } catch (err) {
      this.logger.warn(
        { err, tenantId: result.tenantId },
        'forgot-password: no se pudo leer config SMTP del tenant',
      );
      return;
    }

    if (!smtpRaw) {
      this.logger.warn(
        { tenantId: result.tenantId },
        'forgot-password: tenant sin SMTP configurado, email no enviado',
      );
      return;
    }

    let config;
    try {
      config = this.smtp.parseConfig(smtpRaw);
    } catch (err) {
      this.logger.warn(
        { err, tenantId: result.tenantId },
        'forgot-password: SMTP del tenant inválido',
      );
      return;
    }

    const { subject, html, text } = this.buildResetEmail(
      result.rawToken,
      result.userName,
      webBaseUrl,
    );
    const sendResult = await this.smtp.send(config, {
      to: args.email,
      subject,
      text,
      html,
    });

    if (!sendResult.ok) {
      this.logger.warn(
        { tenantId: result.tenantId, error: sendResult.error },
        'forgot-password: fallo al enviar email',
      );
    }
  }

  /** SHA-256 hex del token raw — formato consistente con la columna VARCHAR(64). */
  private hashToken(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  /**
   * Resolución de tenant para flujos de password reset. Misma estrategia
   * que AuthService: resolvedTenantId > tenantSlug > email-único entre tenants.
   * Si hay múltiples matches por email, devuelve null (response genérico
   * anti user-enumeration).
   */
  private async resolveTenant(args: {
    email: string;
    tenantSlug?: string;
    resolvedTenantId?: string;
  }) {
    if (args.resolvedTenantId) {
      const t = await this.prisma.tenant.findUnique({
        where: { id: args.resolvedTenantId },
      });
      if (t && t.status === 'ACTIVE') return t;
    }
    if (args.tenantSlug) {
      const t = await this.prisma.tenant.findUnique({ where: { slug: args.tenantSlug } });
      if (t && t.status === 'ACTIVE') return t;
      return null;
    }
    const matches = await this.prisma.user.findMany({
      where: {
        email: args.email,
        deletedAt: null,
        status: 'ACTIVE',
        tenant: { status: 'ACTIVE' },
      },
      include: { tenant: true },
      take: 2,
    });
    if (matches.length === 1) return matches[0]!.tenant;
    return null;
  }

  /** Genera el subject + cuerpos del email de reset. */
  buildResetEmail(
    rawToken: string,
    userName: string | null,
    webBaseUrl: string,
  ): { subject: string; html: string; text: string } {
    const link = `${webBaseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(
      rawToken,
    )}`;
    const greeting = userName ? `Hola ${userName},` : 'Hola,';
    const subject = 'Restablecer tu contraseña en Didacta';
    const text = `${greeting}

Recibimos una solicitud para restablecer la contraseña de tu cuenta en Didacta.

Para definir una contraseña nueva, abrí este enlace (válido por ${TOKEN_TTL_MINUTES} minutos):

${link}

Si no fuiste tú, puedes ignorar este mensaje — tu contraseña actual sigue intacta.

— Equipo Didacta`;
    const html = `<!DOCTYPE html>
<html lang="es"><body style="font-family: 'Inter', system-ui, sans-serif; color: #0D1B2A; line-height: 1.6;">
  <p>${greeting}</p>
  <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en Didacta.</p>
  <p>Para definir una contraseña nueva, hacé clic en el botón (válido por ${TOKEN_TTL_MINUTES} minutos):</p>
  <p style="margin: 32px 0;">
    <a href="${link}" style="display: inline-block; background: #1E5AA8; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
      Restablecer contraseña
    </a>
  </p>
  <p style="font-size: 14px; color: #5b6b7c;">
    O copiá este enlace en tu navegador: <br>
    <span style="word-break: break-all;">${link}</span>
  </p>
  <p style="font-size: 14px; color: #5b6b7c;">
    Si no fuiste tú, puedes ignorar este mensaje — tu contraseña actual sigue intacta.
  </p>
  <p style="margin-top: 32px; font-size: 12px; color: #94a3b8;">— Equipo Didacta</p>
</body></html>`;
    return { subject, html, text };
  }
}
