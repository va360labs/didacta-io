import { createHash, randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { SmtpAdapterService } from '../modules/smtp-adapter.service';
import { TenantSmtpResolverService } from '../modules/tenant-smtp-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ClientContext } from '../auth/client-context';
import { buildOtpEmail } from './email-templates';
import { resolveEmailBranding, type BrandingPrisma } from '../common/branded-email';

/** TTL del código OTP: 10 minutos. */
const CODE_TTL_MINUTES = 10;
/** Intentos máximos de verificación por código antes de invalidarlo. */
const MAX_ATTEMPTS = 5;

/**
 * Servicio de verificación de email por OTP de 6 dígitos (paso 1.5 del flujo
 * de inscripción de miembros).
 *
 * Decisiones de seguridad (clon del patrón de PasswordResetService):
 * - El código de 6 dígitos viaja SOLO por email. La BD persiste el SHA-256
 *   hex del código: imposible recuperar el original ni con dump completo.
 * - Single-use: al verificar con éxito se marca `usedAt`. Al pedir uno nuevo
 *   se invalidan los previos vigentes del mismo (tenant, email).
 * - TTL 10 minutos. Más allá se rechaza.
 * - Rate-limit por código: tras MAX_ATTEMPTS verificaciones fallidas el
 *   código queda inservible (hay que pedir uno nuevo).
 * - El envío de email es best-effort: si no hay SMTP resoluble o el send
 *   falla, se loguea warn y NO se lanza (el endpoint igual responde ok para
 *   no leakear si el email existe).
 * - NUNCA se loguea el código en claro.
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly smtp: SmtpAdapterService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Genera un código OTP de 6 dígitos, invalida los previos vigentes del
   * mismo (tenant, email), persiste su hash y lo envía por email (best-effort).
   *
   * Devuelve el TTL en segundos (para que el endpoint informe `expiresInSeconds`).
   * NUNCA loguea el código en claro.
   */
  async requestCode(tenantId: string, email: string, ctx: ClientContext): Promise<number> {
    // randomInt(min, max) excluye el límite superior: [100000, 1000000) → 6 dígitos.
    const code = String(randomInt(100000, 1000000));
    const codeHash = this.hashCode(code);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60_000);

    // Invalidar códigos previos no usados y aún vigentes — limita el blast
    // radius si un atacante pudiese interceptar el primer email.
    await this.prisma.emailVerificationCode.updateMany({
      where: { tenantId, email, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });

    await this.prisma.emailVerificationCode.create({
      data: {
        tenantId,
        email,
        codeHash,
        expiresAt,
        attempts: 0,
        requestIp: ctx.ip ?? null,
        requestUa: ctx.userAgent ?? null,
      },
    });

    await this.auditLog.record({
      tenantId,
      actorId: null,
      action: 'member.otp.requested',
      resourceType: 'email_verification',
      resourceId: email,
      metadata: { email, expiresAt: expiresAt.toISOString() },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    // Envío best-effort: resolvemos SMTP del tenant (con fallback global) y
    // enviamos. Cualquier fallo se loguea warn y no lanza.
    await this.sendCodeEmail(tenantId, email, code);

    return CODE_TTL_MINUTES * 60;
  }

  /**
   * Verifica un código OTP contra el último emitido para (tenant, email).
   *
   * Devuelve `true` solo si el código coincide, no está usado, no expiró y no
   * superó el límite de intentos. En cualquier otro caso devuelve `false`
   * (sin throw) e incrementa el contador de intentos cuando corresponde.
   */
  async verifyCode(
    tenantId: string,
    email: string,
    code: string,
    ctx: ClientContext,
  ): Promise<boolean> {
    const record = await this.prisma.emailVerificationCode.findFirst({
      where: { tenantId, email, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) return false;
    if (record.attempts >= MAX_ATTEMPTS) return false;
    if (record.expiresAt.getTime() < Date.now()) return false;

    const matches = this.hashCode(code) === record.codeHash;
    if (!matches) {
      // Código incorrecto: sumamos un intento. Tras MAX_ATTEMPTS el código
      // queda inservible (la guarda de arriba lo rechazará).
      await this.prisma.emailVerificationCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      return false;
    }

    // Código correcto: marcamos usado (single-use).
    await this.prisma.emailVerificationCode.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });

    await this.auditLog.record({
      tenantId,
      actorId: null,
      action: 'member.otp.verified',
      resourceType: 'email_verification',
      resourceId: email,
      metadata: { email },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return true;
  }

  /**
   * Resuelve el SMTP del tenant (con fallback global) y envía el email con el
   * código. Best-effort: si no hay SMTP o el send falla, loguea warn y no
   * lanza. NUNCA loguea el código en claro.
   */
  private async sendCodeEmail(tenantId: string, email: string, code: string): Promise<void> {
    const resolved = await this.smtpResolver.resolve(tenantId);
    if (!resolved) {
      this.logger.warn(
        { tenantId },
        'member-otp: ni tenant ni fallback global tienen SMTP — código no enviado',
      );
      return;
    }

    const branding = await resolveEmailBranding(
      this.prisma as unknown as BrandingPrisma,
      tenantId,
      process.env['WEB_PUBLIC_URL']?.trim() ?? '',
    );
    const { subject, text, html } = buildOtpEmail(code, branding);
    const sendResult = await this.smtp.send(
      resolved.config,
      { to: email, subject, text, html },
      branding.tenantName,
    );

    if (!sendResult.ok) {
      this.logger.warn(
        { tenantId, source: resolved.source, error: sendResult.error },
        'member-otp: fallo al enviar el email con el código',
      );
    }
  }

  /** SHA-256 hex del código — formato consistente con la columna VARCHAR(64). */
  private hashCode(code: string): string {
    return createHash('sha256').update(code, 'utf8').digest('hex');
  }
}
