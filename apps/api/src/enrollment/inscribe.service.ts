import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AlreadyEnrolledError, LearningError } from '@didacta/mod-learning';
import type { ClientContext } from '../auth/client-context';
import { PasswordService } from '../auth/password.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { SmtpAdapterService } from '../modules/smtp-adapter.service';
import { TenantSmtpResolverService } from '../modules/tenant-smtp-resolver.service';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  renderBrandedEmail,
  resolveEmailBranding,
  escapeHtml,
  type BrandingPrisma,
  type EmailBranding,
} from '../common/branded-email';
import type { InscribeDto, InscribeEnrollmentResult, InscribeResult } from './inscribe.dto';

const NO_CTX: ClientContext = { ip: null, userAgent: null };
const DEFAULT_ALUMNO_ROLE = 'alumno';

/**
 * Orquesta la inscripción programática de un comprador externo:
 *  1. Busca-o-crea el usuario por email dentro del tenant (ACTIVO + contraseña
 *     temporal + `mustChangePassword=true` si es nuevo).
 *  2. Lo matricula en cada curso (reusa `mod.learning`, idempotente).
 *  3. Si el usuario es nuevo, le envía un email de bienvenida con sus
 *     credenciales temporales (best-effort).
 *
 * Es CORE del host (no un módulo): conecta auth + enrollment para una compra
 * que ocurre fuera de Didacta. Ver PRD "Inscripción externa por API".
 */
@Injectable()
export class InscribeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly registry: ModuleRegistryService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly smtp: SmtpAdapterService,
    private readonly logger: PinoLogger,
  ) {}

  async inscribe(
    tenantId: string,
    actorId: string,
    dto: InscribeDto,
    webBaseUrl: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<InscribeResult> {
    const { userId, created, tempPassword } = await this.findOrCreateUser(
      tenantId,
      actorId,
      dto,
      ctx,
    );

    const learning = this.registry.getLearningService();
    const enrollments: InscribeEnrollmentResult[] = [];
    for (const courseId of dto.courseIds) {
      enrollments.push(await this.enrollOne(tenantId, userId, courseId, learning));
    }

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'enrollment.inscribe.api',
      resourceType: 'user',
      resourceId: userId,
      metadata: {
        email: dto.email,
        userCreated: created,
        externalRef: dto.externalRef ?? null,
        courseIds: dto.courseIds,
        enrollments: enrollments.map((e) => ({
          courseId: e.courseId,
          status: e.status,
          alreadyEnrolled: e.alreadyEnrolled,
        })),
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    if (created && tempPassword) {
      // Best-effort: si falla el envío, el usuario igual queda creado y
      // matriculado; el admin puede reenviar credenciales / reset.
      await this.sendWelcomeEmail(tenantId, dto.email, dto.name ?? null, tempPassword, webBaseUrl);
    }

    return { userId, userCreated: created, enrollments };
  }

  private async enrollOne(
    tenantId: string,
    userId: string,
    courseId: string,
    learning: ReturnType<ModuleRegistryService['getLearningService']>,
  ): Promise<InscribeEnrollmentResult> {
    try {
      const enrollment = await learning.enrollFromApi(tenantId, userId, courseId);
      return {
        courseId,
        enrollmentId: enrollment.id,
        status: 'ACTIVE',
        alreadyEnrolled: false,
      };
    } catch (err) {
      if (err instanceof AlreadyEnrolledError) {
        // Idempotente: ya estaba matriculado. Devolvemos el enrollment vigente.
        const existing = await this.prisma.modLearningEnrollment.findFirst({
          where: { tenantId, userId, courseId },
          select: { id: true },
        });
        return {
          courseId,
          enrollmentId: existing?.id ?? null,
          status: 'ACTIVE',
          alreadyEnrolled: true,
        };
      }
      if (err instanceof LearningError) {
        // Ej. COURSE_NOT_PUBLISHED / curso de otro tenant: no rompemos toda la
        // llamada — reportamos el fallo de ESE curso y seguimos con el resto.
        return {
          courseId,
          enrollmentId: null,
          status: 'FAILED',
          alreadyEnrolled: false,
          error: err.code,
        };
      }
      throw err;
    }
  }

  /**
   * Busca el usuario por (tenant, email). Si no existe, lo crea ACTIVO con una
   * contraseña temporal aleatoria, rol `alumno` y `mustChangePassword=true`.
   * Devuelve la contraseña temporal SOLO cuando crea el usuario (para enviarla
   * por email — nunca se persiste en claro).
   */
  private async findOrCreateUser(
    tenantId: string,
    actorId: string,
    dto: InscribeDto,
    ctx: ClientContext,
  ): Promise<{ userId: string; created: boolean; tempPassword?: string }> {
    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: dto.email } },
      select: { id: true },
    });
    if (existing) {
      return { userId: existing.id, created: false };
    }

    const tempPassword = this.generateTempPassword();
    const passwordHash = await this.passwords.hash(tempPassword);
    const role = await this.prisma.role.findUnique({ where: { name: DEFAULT_ALUMNO_ROLE } });

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId,
          email: dto.email,
          name: dto.name ?? null,
          status: 'ACTIVE',
          passwordHash,
          mustChangePassword: true,
          ...(dto.locale ? { locale: dto.locale } : {}),
        },
      });
      if (role) {
        await tx.userRole.create({ data: { userId: created.id, roleId: role.id } });
      }
      return created;
    });

    if (!role) {
      this.logger.warn(
        { tenantId, userId: user.id },
        `inscribe: rol "${DEFAULT_ALUMNO_ROLE}" no existe en el sistema — usuario creado sin rol`,
      );
    }

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'enrollment.inscribe.user_created',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email: dto.email, externalRef: dto.externalRef ?? null },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return { userId: user.id, created: true, tempPassword };
  }

  /** Contraseña temporal aleatoria (~22 chars base64url). El usuario la cambia al entrar. */
  private generateTempPassword(): string {
    return randomBytes(16).toString('base64url');
  }

  private async sendWelcomeEmail(
    tenantId: string,
    email: string,
    name: string | null,
    tempPassword: string,
    webBaseUrl: string,
  ): Promise<void> {
    try {
      const resolved = await this.smtpResolver.resolve(tenantId);
      if (!resolved) {
        this.logger.warn(
          { tenantId },
          'inscribe: ni tenant ni fallback global tienen SMTP — email de bienvenida no enviado',
        );
        return;
      }
      const branding = await resolveEmailBranding(
        this.prisma as unknown as BrandingPrisma,
        tenantId,
        webBaseUrl,
      );
      const { subject, text, html } = this.buildWelcomeEmail(
        email,
        name,
        tempPassword,
        webBaseUrl,
        branding,
      );
      const result = await this.smtp.send(
        resolved.config,
        { to: email, subject, text, html },
        branding.tenantName,
      );
      if (!result.ok) {
        this.logger.warn(
          { tenantId, error: result.error },
          'inscribe: fallo al enviar email de bienvenida',
        );
      }
    } catch (err) {
      this.logger.warn({ err, tenantId }, 'inscribe: excepción al enviar email de bienvenida');
    }
  }

  buildWelcomeEmail(
    email: string,
    name: string | null,
    tempPassword: string,
    webBaseUrl: string,
    branding: EmailBranding,
  ): { subject: string; text: string; html: string } {
    const loginUrl = `${webBaseUrl.replace(/\/$/, '')}/signin`;
    const greeting = name ? `Hola ${name},` : 'Hola,';
    const subject = `Tu acceso a ${branding.tenantName}`;
    const bodyText = `${greeting}

Se ha creado tu cuenta en ${branding.tenantName} y ya tienes acceso a tu(s) curso(s).

Entra con estas credenciales temporales:

  Email: ${email}
  Contraseña temporal: ${tempPassword}

Por seguridad, se te pedirá cambiar la contraseña la primera vez que entres.`;
    const bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>
  <p style="margin:0 0 12px;">Se ha creado tu cuenta en ${escapeHtml(
    branding.tenantName,
  )} y ya tienes acceso a tu(s) curso(s).</p>
  <p style="margin:0 0 8px;">Entra con estas credenciales temporales:</p>
  <table style="margin: 16px 0; font-size: 15px;">
    <tr><td style="padding: 2px 8px; color: #5b6b7c;">Email</td><td style="padding: 2px 8px;"><strong>${escapeHtml(email)}</strong></td></tr>
    <tr><td style="padding: 2px 8px; color: #5b6b7c;">Contraseña temporal</td><td style="padding: 2px 8px;"><strong>${escapeHtml(tempPassword)}</strong></td></tr>
  </table>
  <p style="margin:0;font-size: 14px; color: #5b6b7c;">Por seguridad, se te pedirá cambiar la contraseña la primera vez que entres.</p>`;
    const { html, text } = renderBrandedEmail(branding, {
      title: `Tu acceso a ${branding.tenantName}`,
      bodyHtml,
      bodyText,
      cta: { url: loginUrl, label: 'Iniciar sesión' },
    });
    return { subject, text, html };
  }
}
