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
  textToHtmlParagraphs,
  type BrandingPrisma,
  type EmailBranding,
} from '../common/branded-email';
import {
  applyEmailOverride,
  fetchEmailOverride,
  type RawEmailOverride,
  type TemplateOverridePrisma,
} from '../modules/notifications/email-template-catalog';
import { PasswordResetService } from '../auth/password-reset.service';
import { AccessGroupsService } from '../modules/access-groups/access-groups.service';
import type {
  ApiAccessGroupSummary,
  ApiCourseSummary,
  InscribeDto,
  InscribeEnrollmentResult,
  InscribeGroupResult,
  InscribeResult,
  RevokeDto,
  RevokeEnrollmentResult,
  RevokeGroupResult,
  RevokeResult,
} from './inscribe.dto';

const NO_CTX: ClientContext = { ip: null, userAgent: null };
const DEFAULT_ALUMNO_ROLE = 'alumno';
/**
 * TTL del enlace "define tu contraseña" del alta por API: 7 días. El reset
 * normal usa 60 min, pero aquí el comprador puede abrir el email de la compra
 * bastante después, y un enlace caducado genera soporte.
 */
const SET_PASSWORD_TTL_MINUTES = 7 * 24 * 60;

/**
 * Orquesta la inscripción programática de un comprador externo:
 *  1. Busca-o-crea el usuario por email dentro del tenant (ACTIVO + rol
 *     `alumno`). Al nuevo NO se le manda contraseña temporal: recibe un enlace
 *     mágico de "define tu contraseña" (un solo login → directo al onboarding).
 *  2. Lo matricula en cada curso (reusa `mod.learning`, idempotente).
 *  3. `revoke()` da de baja la matrícula creada por API cuando el sistema de
 *     ventas notifica un reembolso/cancelación.
 *  4. `listCourses()` expone el catálogo (con estado) para que el integrador
 *     mapee producto externo → curso.
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
    private readonly passwordReset: PasswordResetService,
    private readonly accessGroups: AccessGroupsService,
    private readonly logger: PinoLogger,
  ) {}

  async inscribe(
    tenantId: string,
    actorId: string,
    dto: InscribeDto,
    webBaseUrl: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<InscribeResult> {
    const { userId, created } = await this.findOrCreateUser(tenantId, actorId, dto, ctx);

    const learning = this.registry.getLearningService();
    const enrollments: InscribeEnrollmentResult[] = [];
    for (const courseId of dto.courseIds ?? []) {
      enrollments.push(await this.enrollOne(tenantId, userId, courseId, learning));
    }

    // Grupos de acceso: es lo que da visibilidad de uno o varios cursos. Asignar
    // el grupo crea los grants + matrículas de todos sus cursos (y la baja los
    // revoca por refcount). Un grupo inválido no rompe el resto de la llamada.
    const accessGroups: InscribeGroupResult[] = [];
    for (const groupId of dto.accessGroupIds ?? []) {
      try {
        const res = await this.accessGroups.assignMembers(tenantId, groupId, [userId]);
        accessGroups.push({
          groupId,
          status: res.added > 0 ? 'ASSIGNED' : 'ALREADY_MEMBER',
        });
      } catch (err) {
        accessGroups.push({
          groupId,
          status: 'FAILED',
          error: (err as Error).message?.slice(0, 200) ?? 'error',
        });
      }
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
        courseIds: dto.courseIds ?? [],
        accessGroupIds: dto.accessGroupIds ?? [],
        enrollments: enrollments.map((e) => ({
          courseId: e.courseId,
          status: e.status,
          alreadyEnrolled: e.alreadyEnrolled,
        })),
        accessGroups,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    if (created) {
      // Best-effort: si falla el envío, el usuario igual queda creado y
      // matriculado; siempre puede entrar por "¿olvidaste tu contraseña?".
      await this.sendWelcomeEmail(tenantId, dto.email, dto.name ?? null, webBaseUrl, ctx);
    }

    return { userId, userCreated: created, enrollments, accessGroups };
  }

  /**
   * Da de baja la matrícula creada por la API para un comprador, cuando el
   * sistema de ventas notifica reembolso/cancelación del pedido.
   *
   * Idempotente y tolerante: si el email no existe en el tenant devuelve
   * `userFound: false` (no 404) y si un curso no tenía matrícula viva por API
   * lo reporta como `NOT_ENROLLED`. SOLO cancela enrollments `source = 'API'`:
   * el acceso por grupo/suscripción/compra directa NO se toca.
   */
  async revoke(
    tenantId: string,
    actorId: string,
    dto: RevokeDto,
    ctx: ClientContext = NO_CTX,
  ): Promise<RevokeResult> {
    const user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: dto.email } },
      select: { id: true },
    });

    if (!user) {
      await this.auditLog.record({
        tenantId,
        actorId,
        action: 'enrollment.revoke.api',
        resourceType: 'user',
        resourceId: dto.email,
        metadata: {
          email: dto.email,
          userFound: false,
          externalRef: dto.externalRef ?? null,
          reason: dto.reason ?? null,
        },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
      return {
        userFound: false,
        userId: null,
        revoked: (dto.courseIds ?? []).map((courseId) => ({
          courseId,
          status: 'NOT_ENROLLED' as const,
        })),
        accessGroups: (dto.accessGroupIds ?? []).map((groupId) => ({
          groupId,
          status: 'NOT_MEMBER' as const,
        })),
      };
    }

    const learning = this.registry.getLearningService();
    const revoked: RevokeEnrollmentResult[] = [];
    for (const courseId of dto.courseIds ?? []) {
      const count = await learning.unenrollFromApi(tenantId, user.id, courseId);
      revoked.push({ courseId, status: count > 0 ? 'REVOKED' : 'NOT_ENROLLED' });
    }

    // Retirar el grupo revoca sus grants y desmatricula POR REFCOUNT: si otro
    // grupo sigue otorgando el mismo curso, el alumno conserva el acceso.
    const accessGroups: RevokeGroupResult[] = [];
    for (const groupId of dto.accessGroupIds ?? []) {
      try {
        const res = await this.accessGroups.revokeMember(tenantId, groupId, user.id);
        accessGroups.push({ groupId, status: res.revoked ? 'REVOKED' : 'NOT_MEMBER' });
      } catch (err) {
        accessGroups.push({
          groupId,
          status: 'FAILED',
          error: (err as Error).message?.slice(0, 200) ?? 'error',
        });
      }
    }

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'enrollment.revoke.api',
      resourceType: 'user',
      resourceId: user.id,
      metadata: {
        email: dto.email,
        userFound: true,
        externalRef: dto.externalRef ?? null,
        reason: dto.reason ?? null,
        revoked,
        accessGroups,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return { userFound: true, userId: user.id, revoked, accessGroups };
  }

  /**
   * Grupos de acceso del tenant, para que el integrador mapee su producto
   * (pack / membresía) → grupo. `courseCount` indica cuántos cursos otorga.
   */
  async listAccessGroups(tenantId: string): Promise<ApiAccessGroupSummary[]> {
    const { groups } = await this.accessGroups.listGroups(tenantId, 1, 50);
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      courseCount: g.courseCount ?? 0,
    }));
  }

  /**
   * Catálogo de cursos del tenant para que el integrador externo mapee su
   * producto → curso. Incluye los NO publicados (con su `status`) para que se
   * vea por qué un curso aún no admite matrícula: sólo los `PUBLISHED` la
   * aceptan en `POST /inscribe`.
   */
  async listCourses(tenantId: string): Promise<ApiCourseSummary[]> {
    const courses = await this.registry.getCoursesService().listCourses(tenantId);
    return courses.map((c) => ({
      id: c.id,
      title: c.title,
      slug: c.slug,
      status: c.status,
      category: c.category ?? null,
      publishedAt: c.publishedAt ? new Date(c.publishedAt).toISOString() : null,
    }));
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
   * Busca el usuario por (tenant, email). Si no existe, lo crea ACTIVO con rol
   * `alumno` y una contraseña aleatoria INUTILIZABLE (nadie la conoce): el
   * comprador define la suya con el enlace mágico del email de bienvenida.
   *
   * `mustChangePassword` queda en false a propósito: como el usuario elige su
   * contraseña en el propio enlace, forzar además la pantalla de cambio le
   * obligaría a un segundo login antes del onboarding.
   */
  private async findOrCreateUser(
    tenantId: string,
    actorId: string,
    dto: InscribeDto,
    ctx: ClientContext,
  ): Promise<{ userId: string; created: boolean }> {
    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: dto.email } },
      select: { id: true },
    });
    if (existing) {
      return { userId: existing.id, created: false };
    }

    const passwordHash = await this.passwords.hash(this.generateTempPassword());
    const role = await this.prisma.role.findUnique({ where: { name: DEFAULT_ALUMNO_ROLE } });

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId,
          email: dto.email,
          name: dto.name ?? null,
          status: 'ACTIVE',
          passwordHash,
          mustChangePassword: false,
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

    return { userId: user.id, created: true };
  }

  /** Contraseña aleatoria inutilizable (~22 chars). Nadie la conoce: el comprador
   * define la suya con el enlace mágico. */
  private generateTempPassword(): string {
    return randomBytes(16).toString('base64url');
  }

  /**
   * Email de bienvenida con enlace mágico "Define tu contraseña" (TTL 7 días).
   * Reusa el motor de tokens del reset de contraseña, así que el enlace es de un
   * solo uso y hasheado en BD. Best-effort: si no hay SMTP o falla el envío, se
   * loguea y se sigue (el comprador puede usar "¿olvidaste tu contraseña?").
   */
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
        this.logger.warn(
          { tenantId },
          'inscribe: ni tenant ni fallback global tienen SMTP — email de bienvenida no enviado',
        );
        return;
      }

      // Token de "define tu contraseña" con TTL largo (compra → puede abrirlo días después).
      const issued = await this.passwordReset.request({ email, resolvedTenantId: tenantId }, ctx, {
        ttlMinutes: SET_PASSWORD_TTL_MINUTES,
      });
      if (!issued) {
        this.logger.warn(
          { tenantId },
          'inscribe: no se pudo emitir el token de define-contraseña — email no enviado',
        );
        return;
      }
      const setPasswordUrl = `${webBaseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(
        issued.rawToken,
      )}`;

      const branding = await resolveEmailBranding(
        this.prisma as unknown as BrandingPrisma,
        tenantId,
        webBaseUrl,
      );
      const override = await fetchEmailOverride(
        this.prisma as unknown as TemplateOverridePrisma,
        tenantId,
        'enrollment.welcome',
      );
      const { subject, text, html } = this.buildWelcomeEmail(
        email,
        name,
        setPasswordUrl,
        branding,
        override,
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

  /**
   * Email de bienvenida del alta por API: en vez de una contraseña temporal,
   * lleva un enlace mágico para que el comprador DEFINA su contraseña. Así entra
   * una sola vez y aterriza directo en el onboarding.
   */
  buildWelcomeEmail(
    email: string,
    name: string | null,
    setPasswordUrl: string,
    branding: EmailBranding,
    override?: RawEmailOverride | null,
  ): { subject: string; text: string; html: string } {
    const greeting = name ? `Hola ${name},` : 'Hola,';

    if (override) {
      // Texto editado por el tenant; el botón «Define tu contraseña» con el
      // enlace mágico es estructural y se añade siempre.
      const vars = {
        greeting,
        name: name ?? '',
        email,
        tenantName: branding.tenantName,
        setPasswordUrl,
      };
      const applied = applyEmailOverride(override, vars, `Tu acceso a ${branding.tenantName}`);
      const { html, text } = renderBrandedEmail(branding, {
        title: applied.subject,
        bodyHtml: textToHtmlParagraphs(applied.bodyText),
        bodyText: applied.bodyText,
        cta: { url: setPasswordUrl, label: 'Define tu contraseña' },
      });
      return { subject: applied.subject, text, html };
    }

    const subject = `Tu acceso a ${branding.tenantName}`;
    const bodyText = `${greeting}

Se ha creado tu cuenta en ${branding.tenantName} y ya tienes acceso a tu(s) curso(s).

Define tu contraseña con este enlace (válido 7 días) y entra:

${setPasswordUrl}

Tu usuario es ${email}. Si el enlace caduca, usa "¿Olvidaste tu contraseña?" en la pantalla de acceso.`;
    const bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>
  <p style="margin:0 0 12px;">Se ha creado tu cuenta en ${escapeHtml(
    branding.tenantName,
  )} y ya tienes acceso a tu(s) curso(s).</p>
  <p style="margin:0 0 12px;">Solo te queda <strong>definir tu contraseña</strong> con el botón de abajo (el enlace vale 7 días).</p>
  <p style="margin:0;font-size: 14px; color: #5b6b7c;">Tu usuario es <strong>${escapeHtml(
    email,
  )}</strong>. Si el enlace caduca, usa «¿Olvidaste tu contraseña?» en la pantalla de acceso.</p>`;
    const { html, text } = renderBrandedEmail(branding, {
      title: `Tu acceso a ${branding.tenantName}`,
      bodyHtml,
      bodyText,
      cta: { url: setPasswordUrl, label: 'Define tu contraseña' },
    });
    return { subject, text, html };
  }
}
