import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../modules/prisma-tenant-config.service';
import { SmtpAdapterService } from '../modules/smtp-adapter.service';
import { TenantSmtpResolverService } from '../modules/tenant-smtp-resolver.service';
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
    // Opcional para compat con tests que aún no inyectan el resolver:
    // si no está presente, caemos al path histórico de leer SMTP del tenant
    // directo del TenantConfigService (sin fallback a env globales).
    @Optional() private readonly smtpResolver?: TenantSmtpResolverService,
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
    tenantName: string;
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

    return {
      rawToken,
      userId: user.id,
      userName: user.name,
      tenantId: tenant.id,
      // alpha.77 — branding por tenant en emails. Si el tenant no tiene
      // name (caso bordeline en tests fake o data legacy), caemos a 'Didacta'.
      tenantName: (tenant as { name?: string | null }).name ?? 'Didacta',
    };
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

    // alpha.75 — pasamos por el TenantSmtpResolverService cuando está
    // disponible. Eso permite que el reset funcione aunque el tenant aún
    // no configuró SMTP propio: si el despliegue tiene SMTP_HOST/PORT/FROM
    // globales, los usamos como fallback. Si no, log+skip (anti-leak: el
    // endpoint igual devuelve 200 genérico).
    let config;
    if (this.smtpResolver) {
      const resolved = await this.smtpResolver.resolve(result.tenantId);
      if (!resolved) {
        this.logger.warn(
          { tenantId: result.tenantId },
          'forgot-password: ni tenant ni fallback global tienen SMTP — email no enviado',
        );
        return;
      }
      config = resolved.config;
    } else {
      // Path legacy (tests no inyectaron resolver).
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

      try {
        config = this.smtp.parseConfig(smtpRaw);
      } catch (err) {
        this.logger.warn(
          { err, tenantId: result.tenantId },
          'forgot-password: SMTP del tenant inválido',
        );
        return;
      }
    }

    // alpha.82 — branding por tenant en emails: si el tenant configuró un
    // logo (subido al storage o URL externa), lo embebemos en el header del
    // HTML. La lectura es best-effort: si el módulo theming no tiene fila o
    // la query falla, seguimos sin logo (no rompe el envío).
    const logoUrl = await this.resolveTenantLogoUrl(result.tenantId, webBaseUrl);

    const { subject, html, text } = this.buildResetEmail(
      result.rawToken,
      result.userName,
      webBaseUrl,
      result.tenantName,
      logoUrl,
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
   * Resuelve la URL ABSOLUTA del logo del tenant para embeber en emails, o
   * null si el tenant no configuró logo. El theme de mod.theming guarda:
   *   - `logoUrl` https:// externo → se usa tal cual.
   *   - `logoUrl` relativo (/api/v1/modules/theming/tenants/:id/logo?v=…)
   *     cuando el logo se subió al storage → se prefija con la URL pública
   *     del API (`PUBLIC_API_URL`, fallback al webBaseUrl que comparte
   *     dominio en el setup Traefik de Didacta).
   *
   * Best-effort: cualquier error (sin fila, query falla) devuelve null para
   * que el email se envíe igual sin logo (no rompemos el reset por branding).
   */
  private async resolveTenantLogoUrl(tenantId: string, webBaseUrl: string): Promise<string | null> {
    try {
      const theme = await this.prisma.modThemingTenantTheme.findUnique({
        where: { tenantId },
        select: { logoUrl: true },
      });
      const logoUrl = theme?.logoUrl;
      if (!logoUrl) return null;
      if (/^https?:\/\//i.test(logoUrl)) return logoUrl;
      // Relativo: prefijar con la base pública del API. En el setup Traefik
      // de Didacta el API y el web comparten dominio, así que webBaseUrl es
      // un fallback razonable cuando PUBLIC_API_URL no está set.
      const apiBaseRaw = process.env['PUBLIC_API_URL']?.trim() || webBaseUrl;
      const apiBase = apiBaseRaw.endsWith('/') ? apiBaseRaw.slice(0, -1) : apiBaseRaw;
      const path = logoUrl.startsWith('/') ? logoUrl : `/${logoUrl}`;
      return `${apiBase}${path}`;
    } catch (err) {
      this.logger.warn(
        { err, tenantId },
        'forgot-password: no se pudo resolver el logo del tenant — email sin logo',
      );
      return null;
    }
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

  /**
   * Genera el subject + cuerpos del email de reset.
   *
   * alpha.77 — branding por tenant:
   *   - El email se firma con el nombre del tenant ("Equipo {tenantName}")
   *     en lugar del genérico "Equipo Didacta". Esto evita que un usuario
   *     de "VA360 Academy" reciba un mail "de Didacta" y dude si es phishing.
   *   - Se añade un footer discreto "Powered by Didacta.io" para mantener
   *     atribución legal de la plataforma sin pisar el branding del tenant.
   *   - `tenantName` cae a "Didacta" si no se pasa (compat con call sites
   *     legacy / tests).
   *
   * alpha.82 — logo por tenant:
   *   - Si `logoUrl` (absoluto) viene set, se renderiza en el header del HTML
   *     encima del saludo. Si no, no se renderiza nada (el `tenantName` en el
   *     texto/firma sigue identificando al tenant). El parámetro NO afecta al
   *     cuerpo de texto plano (los clientes que no cargan imágenes igual ven
   *     el nombre del tenant).
   */
  buildResetEmail(
    rawToken: string,
    userName: string | null,
    webBaseUrl: string,
    tenantName: string = 'Didacta',
    logoUrl: string | null = null,
  ): { subject: string; html: string; text: string } {
    const link = `${webBaseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(
      rawToken,
    )}`;
    const greeting = userName ? `Hola ${userName},` : 'Hola,';
    const subject = `Restablecer tu contraseña en ${tenantName}`;
    // Header con logo del tenant, solo si está configurado y es una URL
    // absoluta http(s). `tenantName` se usa como alt para accesibilidad y
    // fallback cuando el cliente no carga imágenes.
    const logoHeader =
      logoUrl && /^https?:\/\//i.test(logoUrl)
        ? `  <div style="margin: 0 0 24px;">
    <img src="${logoUrl}" alt="${escapeHtmlAttr(tenantName)}" style="max-height: 48px; max-width: 200px; object-fit: contain;" />
  </div>
`
        : '';
    const text = `${greeting}

Recibimos una solicitud para restablecer la contraseña de tu cuenta en ${tenantName}.

Para definir una contraseña nueva, abrí este enlace (válido por ${TOKEN_TTL_MINUTES} minutos):

${link}

Si no fuiste tú, puedes ignorar este mensaje — tu contraseña actual sigue intacta.

— Equipo ${tenantName}

—
Powered by Didacta.io`;
    const html = `<!DOCTYPE html>
<html lang="es"><body style="font-family: 'Inter', system-ui, sans-serif; color: #0D1B2A; line-height: 1.6;">
${logoHeader}  <p>${greeting}</p>
  <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en ${tenantName}.</p>
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
  <p style="margin-top: 32px; font-size: 12px; color: #94a3b8;">— Equipo ${tenantName}</p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 12px;" />
  <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">
    Powered by Didacta.io
  </p>
</body></html>`;
    return { subject, html, text };
  }
}

/**
 * Escapa los caracteres que romperían un atributo HTML entre comillas dobles.
 * Usado para inyectar `tenantName` como `alt` del logo sin abrir XSS.
 */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
