import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ClientContext } from '../auth/client-context';
import { PasswordResetService } from '../auth/password-reset.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

const NO_CTX: ClientContext = { ip: null, userAgent: null };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOSTNAME_RE = /^[a-z0-9.-]{1,253}$/;

export interface TenantListItem {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  createdAt: string;
  domains: Array<{ hostname: string; isPrimary: boolean; isVerified: boolean }>;
  userCount: number;
  courseCount: number;
}

/**
 * Servicio CRUD para super_admin sobre la tabla `tenant`.
 *
 * HU-SA-001: alta de tenant + suspensión + asignación de dominios.
 *
 * Reglas:
 *  - Slug único, regex `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` (DNS-safe).
 *  - Al crear tenant también se crea el primer tenant_admin via email +
 *    se le envía el link de "definí tu contraseña" reusando PasswordResetService.
 *  - Suspender un tenant invalida sessions de TODOS sus usuarios y bloquea
 *    futuros logins (ver AuthService.signin).
 */
@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly passwordReset: PasswordResetService,
    private readonly logger: PinoLogger,
  ) {}

  async list(): Promise<TenantListItem[]> {
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { domains: true, _count: { select: { users: true } } },
    });

    // Course counts por tenant (consulta separada porque cursos viven en otra tabla).
    const courseCounts = await this.prisma.modCoursesCourse.groupBy({
      by: ['tenantId'],
      _count: { id: true },
    });
    const countByTenant = new Map(courseCounts.map((c) => [c.tenantId, c._count.id]));

    return tenants.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      domains: t.domains.map(
        (d: { hostname: string; isPrimary: boolean; isVerified: boolean }) => ({
          hostname: d.hostname,
          isPrimary: d.isPrimary,
          isVerified: d.isVerified,
        }),
      ),
      userCount: t._count.users,
      courseCount: countByTenant.get(t.id) ?? 0,
    }));
  }

  async getDetail(id: string): Promise<TenantListItem> {
    const t = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
      include: { domains: true, _count: { select: { users: true } } },
    });
    if (!t) throw new NotFoundException('Tenant no encontrado.');

    const courseCount = await this.prisma.modCoursesCourse.count({ where: { tenantId: id } });

    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      domains: t.domains.map(
        (d: { hostname: string; isPrimary: boolean; isVerified: boolean }) => ({
          hostname: d.hostname,
          isPrimary: d.isPrimary,
          isVerified: d.isVerified,
        }),
      ),
      userCount: t._count.users,
      courseCount,
    };
  }

  /**
   * Alta de tenant + primer tenant_admin + dominio primario.
   * El admin recibe email para definir contraseña (no se le da una temporal).
   */
  async create(
    actorId: string,
    dto: {
      slug: string;
      name: string;
      adminEmail: string;
      adminName?: string;
      primaryHostname: string;
    },
    webBaseUrl: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantListItem> {
    if (!SLUG_RE.test(dto.slug)) {
      throw new BadRequestException(
        'El slug debe ser DNS-safe: minúsculas, números y guiones, sin empezar/terminar en guión, máx. 63 chars.',
      );
    }
    const hostname = dto.primaryHostname.trim().toLowerCase();
    if (!HOSTNAME_RE.test(hostname)) {
      throw new BadRequestException('Hostname inválido.');
    }

    const existingSlug = await this.prisma.tenant.findUnique({ where: { slug: dto.slug } });
    if (existingSlug) {
      throw new ConflictException(`Ya existe un tenant con slug "${dto.slug}".`);
    }
    const existingDomain = await this.prisma.tenantDomain.findUnique({ where: { hostname } });
    if (existingDomain) {
      throw new ConflictException(`El hostname "${hostname}" ya está asignado a otro tenant.`);
    }

    const tenantAdminRole = await this.prisma.role.findUnique({
      where: { name: 'tenant_admin' },
    });
    if (!tenantAdminRole) {
      throw new BadRequestException('Rol tenant_admin no existe en seed.');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          slug: dto.slug,
          name: dto.name,
          status: 'ACTIVE',
        },
      });
      await tx.tenantDomain.create({
        data: {
          tenantId: tenant.id,
          hostname,
          isPrimary: true,
          isVerified: true,
        },
      });
      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: dto.adminEmail,
          name: dto.adminName ?? null,
          status: 'PENDING',
        },
      });
      await tx.userRole.create({
        data: { userId: admin.id, roleId: tenantAdminRole.id },
      });
      return { tenant, admin };
    });

    await this.auditLog.record({
      tenantId: created.tenant.id,
      actorId,
      action: 'admin.tenant.created',
      resourceType: 'tenant',
      resourceId: created.tenant.id,
      metadata: {
        slug: dto.slug,
        primaryHostname: hostname,
        adminEmail: dto.adminEmail,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    // Email de bienvenida al tenant_admin para definir su contraseña.
    try {
      await this.passwordReset.requestAndSendEmail(
        { email: dto.adminEmail, resolvedTenantId: created.tenant.id },
        webBaseUrl,
        ctx,
      );
    } catch (err) {
      this.logger.warn(
        { err, tenantId: created.tenant.id },
        'admin.tenant.create: fallo al enviar email de bienvenida; el super_admin puede reenviar',
      );
    }

    return this.getDetail(created.tenant.id);
  }

  async setStatus(
    actorId: string,
    id: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED',
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantListItem> {
    const t = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
    });
    if (!t) throw new NotFoundException('Tenant no encontrado.');

    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id }, data: { status } });
      // Si suspendemos o archivamos, invalidar sessions activas de todos los users.
      if (status !== 'ACTIVE') {
        await tx.session.deleteMany({
          where: { tenantId: id, expiresAt: { gt: new Date() } },
        });
      }
    });

    await this.auditLog.record({
      tenantId: id,
      actorId,
      action: `admin.tenant.status_changed.${status.toLowerCase()}`,
      resourceType: 'tenant',
      resourceId: id,
      metadata: { previousStatus: t.status, newStatus: status },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return this.getDetail(id);
  }

  async addDomain(
    actorId: string,
    tenantId: string,
    hostname: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantListItem> {
    const host = hostname.trim().toLowerCase();
    if (!HOSTNAME_RE.test(host)) {
      throw new BadRequestException('Hostname inválido.');
    }
    const existing = await this.prisma.tenantDomain.findUnique({ where: { hostname: host } });
    if (existing) {
      throw new ConflictException(
        `El hostname "${host}" ya está asignado (al mismo o a otro tenant).`,
      );
    }
    await this.prisma.tenantDomain.create({
      data: { tenantId, hostname: host, isPrimary: false, isVerified: true },
    });
    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.tenant.domain_added',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { hostname: host },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return this.getDetail(tenantId);
  }

  async removeDomain(
    actorId: string,
    tenantId: string,
    hostname: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantListItem> {
    const host = hostname.trim().toLowerCase();
    const domain = await this.prisma.tenantDomain.findFirst({
      where: { tenantId, hostname: host },
    });
    if (!domain) {
      throw new NotFoundException('Dominio no encontrado en este tenant.');
    }
    if (domain.isPrimary) {
      throw new BadRequestException(
        'No podés eliminar el dominio primario. Asigná otro como primario antes.',
      );
    }
    await this.prisma.tenantDomain.delete({ where: { id: domain.id } });
    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.tenant.domain_removed',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { hostname: host },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return this.getDetail(tenantId);
  }
}
