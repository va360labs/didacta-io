import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ClientContext } from '../auth/client-context';
import { PasswordResetService } from '../auth/password-reset.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

const NO_CTX: ClientContext = { ip: null, userAgent: null };

/**
 * Roles que un tenant_admin puede asignar dentro de su tenant.
 * NUNCA puede otorgar super_admin (eso lo hace el bootstrap o un super_admin
 * existente vía Prisma directo).
 */
export const TENANT_ASSIGNABLE_ROLES = [
  'tenant_admin',
  'formador',
  'alumno',
  'auditor',
  'empresa_manager',
] as const;

export type AssignableRole = (typeof TENANT_ASSIGNABLE_ROLES)[number];

export interface UserListItem {
  id: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
  roles: string[];
  mfaEnabled: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface UserDetail extends UserListItem {
  locale: string;
  updatedAt: string;
  recentSessions: Array<{ id: string; createdAt: string; expiresAt: string }>;
}

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly passwordReset: PasswordResetService,
    private readonly logger: PinoLogger,
  ) {}

  async list(
    tenantId: string,
    options: { search?: string; status?: string; role?: string; limit?: number },
  ): Promise<UserListItem[]> {
    const where: Record<string, unknown> = { tenantId, deletedAt: null };
    if (options.status) where.status = options.status;
    if (options.search) {
      const q = options.search.trim();
      if (q) {
        where.OR = [
          { email: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ];
      }
    }

    const users = await this.prisma.user.findMany({
      where,
      include: { roles: { include: { role: true } } },
      orderBy: { createdAt: 'desc' },
      take: options.limit ?? 100,
    });

    let mapped = users.map((u) => this.toListItem(u));

    if (options.role) {
      mapped = mapped.filter((u) => u.roles.includes(options.role!));
    }
    return mapped;
  }

  async getDetail(tenantId: string, userId: string): Promise<UserDetail> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
      include: {
        roles: { include: { role: true } },
        sessions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    return {
      ...this.toListItem(user),
      locale: user.locale,
      updatedAt: user.updatedAt.toISOString(),
      recentSessions: user.sessions.map((s: { id: string; createdAt: Date; expiresAt: Date }) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
      })),
    };
  }

  /**
   * Invita a un usuario nuevo: crea el User con status=PENDING (sin password),
   * le asigna el rol seleccionado y envía email con link de reset para que
   * el usuario defina su contraseña. Al primer signin queda ACTIVE.
   */
  async invite(
    tenantId: string,
    actorId: string,
    dto: { email: string; name?: string; role: AssignableRole },
    webBaseUrl: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<UserListItem> {
    if (!TENANT_ASSIGNABLE_ROLES.includes(dto.role)) {
      throw new BadRequestException(`Rol "${dto.role}" no asignable.`);
    }

    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: dto.email } },
    });
    if (existing) {
      throw new ConflictException('Ya existe un usuario con ese email en esta organización.');
    }

    const role = await this.prisma.role.findUnique({ where: { name: dto.role } });
    if (!role) throw new BadRequestException(`El rol "${dto.role}" no existe en el sistema.`);

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Tenant no encontrado.');

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId,
          email: dto.email,
          name: dto.name ?? null,
          status: 'PENDING',
        },
      });
      await tx.userRole.create({
        data: { userId: created.id, roleId: role.id },
      });
      return created;
    });

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.user.invited',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email: dto.email, role: dto.role },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    // Enviar email de "definí tu contraseña" reusando el flujo de reset.
    try {
      await this.passwordReset.requestAndSendEmail(tenant.slug, dto.email, webBaseUrl, ctx);
    } catch (err) {
      this.logger.warn(
        { err, userId: user.id },
        'admin.invite: fallo al enviar email de bienvenida; el admin puede reenviar',
      );
    }

    const detail = await this.getDetail(tenantId, user.id);
    return detail;
  }

  async setStatus(
    tenantId: string,
    actorId: string,
    userId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED',
    ctx: ClientContext = NO_CTX,
  ): Promise<UserListItem> {
    if (userId === actorId && status !== 'ACTIVE') {
      throw new BadRequestException('No podés suspender ni desactivar tu propio usuario.');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status } });
      // Invalidar sessions activas si suspendemos / desactivamos.
      if (status !== 'ACTIVE') {
        await tx.session.deleteMany({ where: { userId, expiresAt: { gt: new Date() } } });
      }
    });

    await this.auditLog.record({
      tenantId,
      actorId,
      action: `admin.user.status_changed.${status.toLowerCase()}`,
      resourceType: 'user',
      resourceId: userId,
      metadata: { previousStatus: user.status, newStatus: status },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return this.getDetail(tenantId, userId);
  }

  async assignRole(
    tenantId: string,
    actorId: string,
    userId: string,
    roleName: AssignableRole,
    ctx: ClientContext = NO_CTX,
  ): Promise<UserListItem> {
    if (!TENANT_ASSIGNABLE_ROLES.includes(roleName)) {
      throw new BadRequestException(`Rol "${roleName}" no asignable.`);
    }
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new BadRequestException(`Rol "${roleName}" no existe.`);

    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId: role.id } },
      create: { userId, roleId: role.id },
      update: {},
    });

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.user.role_assigned',
      resourceType: 'user',
      resourceId: userId,
      metadata: { role: roleName },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return this.getDetail(tenantId, userId);
  }

  async removeRole(
    tenantId: string,
    actorId: string,
    userId: string,
    roleName: AssignableRole,
    ctx: ClientContext = NO_CTX,
  ): Promise<UserListItem> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new BadRequestException(`Rol "${roleName}" no existe.`);

    if (userId === actorId && roleName === 'tenant_admin') {
      throw new BadRequestException(
        'No podés quitarte el rol tenant_admin a vos mismo (te quedarías sin acceso al panel).',
      );
    }

    await this.prisma.userRole.deleteMany({
      where: { userId, roleId: role.id },
    });

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.user.role_removed',
      resourceType: 'user',
      resourceId: userId,
      metadata: { role: roleName },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return this.getDetail(tenantId, userId);
  }

  /**
   * Reenvía el email de "definí tu contraseña" para usuarios PENDING o
   * cualquier usuario que perdió acceso. Usa el flujo de password-reset.
   */
  async resendInvite(
    tenantId: string,
    actorId: string,
    userId: string,
    webBaseUrl: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<{ ok: true }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Tenant no encontrado.');

    await this.passwordReset.requestAndSendEmail(tenant.slug, user.email, webBaseUrl, ctx);

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.user.invite_resent',
      resourceType: 'user',
      resourceId: userId,
      metadata: { email: user.email },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return { ok: true };
  }

  // -------------------- helpers --------------------

  private toListItem(user: {
    id: string;
    email: string;
    name: string | null;
    status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
    mfaEnabled: boolean;
    emailVerified: boolean;
    createdAt: Date;
    lastLoginAt: Date | null;
    roles: Array<{ role: { name: string } }>;
  }): UserListItem {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      roles: user.roles.map((r) => r.role.name),
      mfaEnabled: user.mfaEnabled,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  }
}
