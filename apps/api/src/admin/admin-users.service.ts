/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ClientContext } from '../auth/client-context';
import { PasswordResetService } from '../auth/password-reset.service';
import { AccessGroupsService } from '../modules/access-groups/access-groups.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountStateService } from '../auth/account-state.service';
import { assertSignupsAllowed } from '../tenancy/signup-freeze';

/** Validez del enlace de invitación: 7 días. Ver `resendInvite`. */
const INVITE_TTL_MINUTES = 7 * 24 * 60;

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
  // Seguimiento Fundae (LMS-123): solo lectura y acotado a los grupos que se le
  // concedan. Por sí solo no abre nada — el rol sin concesión no ve un grupo.
  'inspector',
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
  /// Origen del user cuando fue importado por un módulo third-party
  /// (ej. "learndash"). Null para users creados directamente en Didacta.
  /// Permite al operador identificar qué users vienen de una migración. Ver ADR-014.
  externalSource: string | null;
  externalId: string | null;
}

export interface UserDetail extends UserListItem {
  locale: string;
  updatedAt: string;
  recentSessions: Array<{ id: string; createdAt: string; expiresAt: string }>;
}

export interface ListUsersOptions {
  search?: string;
  status?: string;
  role?: string;
  externalSource?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedUsers {
  items: UserListItem[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/** Progreso del alta masiva (CSV). En memoria: sobrevive a la petición, no al
 *  reinicio del contenedor (ver doc de `AdminUsersService.bulkImports`). */
export interface BulkInviteState {
  enCurso: boolean;
  total: number;
  creados: number;
  fallidos: Array<{ email: string; error: string }>;
  iniciadoEn: string;
  terminadoEn: string | null;
}

@Injectable()
export class AdminUsersService {
  /**
   * Progreso del alta masiva (CSV) por tenant. En memoria a propósito, mismo
   * criterio que `InvitationsService.envios`: es estado de una operación en
   * vuelo, no un dato del producto. Con más de una instancia de API habría
   * que moverlo a Redis — hoy sirve una sola.
   */
  private readonly bulkImports = new Map<string, BulkInviteState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly passwordReset: PasswordResetService,
    private readonly logger: PinoLogger,
    private readonly accountState: AccountStateService,
    // Mismo patrón que InscribeService: el core llama al service del módulo
    // first-party, nunca a sus tablas. Ver `invite()` con `accessGroupId`.
    private readonly accessGroups: AccessGroupsService,
  ) {}

  /**
   * Lista paginada de users del tenant.
   *
   * Hasta alpha.73 este método ignoraba `page` y devolvía como mucho 100 users,
   * causando que el operador viera "100 alumnos" cuando había miles importados
   * desde LearnDash. Ahora aplica `skip` + `take` de Prisma y reporta `total` +
   * `hasMore` para que el frontend pueda renderizar paginación real.
   *
   * El filtro por `role` va en el WHERE, no in-memory.
   *
   * Aplicarlo después de paginar producía páginas vacías con `hasMore: true` y
   * un `total` que contaba usuarios que la pantalla nunca iba a enseñar: pedir
   * "formadores" en un tenant con miles de alumnos devolvía la página 1 vacía
   * —los cien primeros por fecha son alumnos— sobre un contador de miles. El
   * `some` de Prisma resuelve el join sin `distinct` y deja `total` y
   * `hasMore` diciendo la verdad.
   */
  async list(tenantId: string, options: ListUsersOptions): Promise<PaginatedUsers> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? options.limit : 100;

    const where: Record<string, unknown> = { tenantId, deletedAt: null };
    if (options.status) where.status = options.status;
    if (options.externalSource) where.externalSource = options.externalSource;
    if (options.role) where.roles = { some: { role: { name: options.role } } };
    if (options.search) {
      const q = options.search.trim();
      if (q) {
        where.OR = [
          { email: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ];
      }
    }

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        include: { roles: { include: { role: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const items = users.map((u) => this.toListItem(u));

    return {
      items,
      total,
      page,
      limit,
      hasMore: page * limit < total,
    };
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
    if (!user)
      throw new NotFoundException({
        message: 'Usuario no encontrado',
        code: 'ADMIN_USER_NOT_FOUND',
      });

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
   * Invita a un usuario nuevo: crea el User **ACTIVE** (sin password), le asigna
   * el rol seleccionado y envía email con link de reset para que el usuario
   * defina su contraseña.
   *
   * Por qué ACTIVE y no PENDING: el status NO es el gate de acceso — `signin`
   * exige además `passwordHash`, así que un ACTIVE sin contraseña no puede
   * entrar hasta que use el enlace del email. PENDING solo añadía un segundo
   * candado que nadie abría solo: nada promovía PENDING→ACTIVE, así que el
   * invitado definía su contraseña y AUN ASÍ recibía "Credenciales inválidas"
   * hasta que un admin le daba a "Reactivar acceso" a mano. PENDING queda
   * reservado para el único caso donde significa algo: la inscripción de
   * miembros pendiente de aprobación (`modules/member-registration`).
   *
   * `options.sendInvite` (default `true`): cuando es `false`, el user se crea
   * IGUAL en estado PENDING + se le asigna el rol + queda registrado en audit,
   * pero NO se dispara `passwordReset.requestAndSendEmail` — es decir, no se
   * envía el email de bienvenida/activación. El operador puede notificarlo
   * después con `resendInvite()`. Lo usa el path del migrador (ctx.didacta
   * con `suppressInvite: true`) para importar miles de users sin bombardearlos
   * con emails. El endpoint admin manual NO pasa este flag, así que mantiene
   * el comportamiento por defecto: invitar a mano SÍ envía el email.
   *
   * `dto.accessGroupId` (opcional): añade al invitado a ese grupo de acceso en
   * el mismo alta, con lo que queda matriculado ya en los cursos del grupo
   * (viaje 1: invitar CON aula, no a un campus vacío). El grupo se valida ANTES
   * de crear el user para que un id inválido falle sin dejar el alta a medias;
   * si el fan-out de matrículas falla después, el user queda creado igualmente
   * y el operador lo ve en el grupo desde /admin/grupos-acceso (fail-soft).
   */
  async invite(
    tenantId: string,
    actorId: string,
    dto: { email: string; name?: string; role: AssignableRole; accessGroupId?: string },
    webBaseUrl: string,
    ctx: ClientContext = NO_CTX,
    options: { sendInvite?: boolean } = {},
  ): Promise<UserListItem> {
    const sendInvite = options.sendInvite ?? true;
    // U7: puerta 1 y 2 de 4. El alta masiva por CSV pasa por aqui, asi que
    // congelar cubre las dos con una sola comprobacion.
    await assertSignupsAllowed(this.prisma, tenantId);
    if (!TENANT_ASSIGNABLE_ROLES.includes(dto.role)) {
      throw new BadRequestException({
        message: `Rol "${dto.role}" no asignable.`,
        code: 'ADMIN_ROLE_NOT_ASSIGNABLE',
        detail: dto.role,
      });
    }

    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: dto.email } },
    });
    if (existing) {
      throw new ConflictException({
        message: 'Ya existe un usuario con ese email en esta organización.',
        code: 'ADMIN_USER_EMAIL_EXISTS',
      });
    }

    const role = await this.prisma.role.findUnique({ where: { name: dto.role } });
    if (!role)
      throw new BadRequestException({
        message: `El rol "${dto.role}" no existe en el sistema.`,
        code: 'ADMIN_ROLE_NOT_FOUND',
      });

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant)
      throw new NotFoundException({
        message: 'Tenant no encontrado.',
        code: 'ADMIN_TENANT_NOT_FOUND',
      });

    // Antes de crear nada: un grupo inexistente (o de otro tenant) debe abortar
    // el alta entera con 404, no crear un user a medio configurar.
    if (dto.accessGroupId) {
      await this.accessGroups.getGroup(tenantId, dto.accessGroupId);
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId,
          email: dto.email,
          name: dto.name ?? null,
          status: 'ACTIVE',
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
      metadata: {
        email: dto.email,
        role: dto.role,
        ...(dto.accessGroupId ? { accessGroupId: dto.accessGroupId } : {}),
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    // Alta en el grupo de acceso (y por tanto matrícula en sus cursos). Después
    // de crear el user y a propósito fail-soft: si el fan-out de matrículas
    // falla, el alta ya es válida y reintentarlo es trivial desde el panel.
    if (dto.accessGroupId) {
      try {
        await this.accessGroups.assignMembers(tenantId, dto.accessGroupId, [user.id]);
      } catch (err) {
        this.logger.warn(
          { err, userId: user.id, accessGroupId: dto.accessGroupId },
          'admin.invite: el usuario se creó pero no se pudo añadir al grupo de acceso',
        );
      }
    }

    // Enviar email de "define tu contraseña" reusando el flujo de reset.
    // `allowPending: true` se mantiene por si el user ya existía en PENDING de
    // antes de que las altas pasaran a crearse ACTIVE: sin el flag,
    // password-reset.request() lo descartaría silenciosamente por el guard
    // anti user-enumeration. Ver CORE-FIX-03.
    //
    // Si `sendInvite === false` (path del migrador con suppressInvite) NO se
    // envía nada: el user queda creado en PENDING y el operador lo notifica
    // después con resendInvite(). Ver alpha.81.
    if (sendInvite) {
      try {
        await this.passwordReset.requestAndSendEmail(
          { email: dto.email, resolvedTenantId: tenantId },
          webBaseUrl,
          ctx,
          { allowPending: true, ttlMinutes: INVITE_TTL_MINUTES, asInvitation: true },
        );
      } catch (err) {
        this.logger.warn(
          { err, userId: user.id },
          'admin.invite: fallo al enviar email de bienvenida; el admin puede reenviar',
        );
      }
    }

    const detail = await this.getDetail(tenantId, user.id);
    return detail;
  }

  /**
   * Arranca el alta masiva del CSV y **vuelve enseguida**, sin esperar a que
   * termine. Mismo motivo que `InvitationsService.startBatch`: cada fila hace
   * como mínimo una escritura + un email de bienvenida, así que un CSV de un
   * tamaño moderado ya supera los ~30 s que aguanta el proxy antes de cortar
   * la petición. El progreso se consulta en `estadoBulkInvite()`.
   *
   * Rol y grupo son los mismos para TODO el lote (se eligen una vez en el
   * formulario) — así el CSV solo necesita `email`/`name` por fila, sin pedirle
   * al operador que resuelva ids de grupo por persona.
   */
  async startBulkInvite(
    tenantId: string,
    actorId: string,
    rows: Array<{ email: string; name?: string }>,
    role: AssignableRole,
    accessGroupId: string | undefined,
    webBaseUrl: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<{ aceptado: boolean; yaEnCurso: boolean; total: number }> {
    const enCurso = this.bulkImports.get(tenantId);
    if (enCurso?.enCurso) {
      // Mismo freno que el envío por lotes: dos a la vez podrían pisarse (dos
      // altas del mismo email en la ventana entre el check y el create).
      return { aceptado: false, yaEnCurso: true, total: enCurso.total };
    }

    // Dedup dentro del propio CSV (mismo email dos veces en el archivo): el
    // segundo intento fallaría igual por conflicto, mejor no ni intentarlo.
    const vistos = new Set<string>();
    const filas: Array<{ email: string; name?: string }> = [];
    for (const r of rows) {
      const email = r.email.trim().toLowerCase();
      if (vistos.has(email)) continue;
      vistos.add(email);
      filas.push({ email, name: r.name?.trim() || undefined });
    }

    const ahora = new Date().toISOString();
    this.bulkImports.set(tenantId, {
      enCurso: filas.length > 0,
      total: filas.length,
      creados: 0,
      fallidos: [],
      iniciadoEn: ahora,
      terminadoEn: filas.length > 0 ? null : ahora,
    });

    if (filas.length > 0) {
      void this.procesarBulkInviteEnSegundoPlano(
        tenantId,
        actorId,
        filas,
        role,
        accessGroupId,
        webBaseUrl,
        ctx,
      );
    }
    return { aceptado: true, yaEnCurso: false, total: filas.length };
  }

  /** Estado del alta masiva en curso (o la última terminada), para que el panel lo pinte. */
  estadoBulkInvite(tenantId: string): BulkInviteState | null {
    return this.bulkImports.get(tenantId) ?? null;
  }

  /**
   * El bucle real. Corre desligado de la petición HTTP: NO puede lanzar
   * (sería un unhandled rejection) y siempre termina con `enCurso: false`, o
   * el panel se quedaría diciendo "importando…" para siempre. Cada fila usa
   * `invite()` tal cual (misma validación de rol/grupo, mismo alta ACTIVE,
   * mismo email de bienvenida) — un fallo en una fila (email duplicado, etc.)
   * no corta el resto del lote.
   */
  private async procesarBulkInviteEnSegundoPlano(
    tenantId: string,
    actorId: string,
    filas: Array<{ email: string; name?: string }>,
    role: AssignableRole,
    accessGroupId: string | undefined,
    webBaseUrl: string,
    ctx: ClientContext,
  ): Promise<void> {
    const estado = this.bulkImports.get(tenantId);

    try {
      for (const fila of filas) {
        try {
          await this.invite(
            tenantId,
            actorId,
            { email: fila.email, name: fila.name, role, accessGroupId },
            webBaseUrl,
            ctx,
          );
          if (estado) estado.creados += 1;
        } catch (err) {
          if (estado) {
            estado.fallidos.push({ email: fila.email, error: (err as Error).message ?? 'error' });
          }
        }
      }
    } catch (err) {
      this.logger.error(
        { tenantId, err: err instanceof Error ? err.message : String(err) },
        'admin.bulk-invite: el lote se cortó por un error inesperado',
      );
    } finally {
      if (estado) {
        estado.enCurso = false;
        estado.terminadoEn = new Date().toISOString();
      }
      this.logger.log(
        {
          tenantId,
          actorId,
          creados: estado?.creados ?? 0,
          fallidos: estado?.fallidos.length ?? 0,
        },
        'admin.bulk-invite: lote procesado',
      );
    }
  }

  async setStatus(
    tenantId: string,
    actorId: string,
    userId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED',
    ctx: ClientContext = NO_CTX,
  ): Promise<UserListItem> {
    if (userId === actorId && status !== 'ACTIVE') {
      throw new BadRequestException({
        message: 'No puedes suspender ni desactivar tu propio usuario.',
        code: 'ADMIN_USER_SELF_STATUS_FORBIDDEN',
      });
    }

    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
    });
    if (!user)
      throw new NotFoundException({
        message: 'Usuario no encontrado.',
        code: 'ADMIN_USER_NOT_FOUND',
      });

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status } });
      // Invalidar sessions activas si suspendemos / desactivamos.
      if (status !== 'ACTIVE') {
        await tx.session.deleteMany({ where: { userId, expiresAt: { gt: new Date() } } });
      }
    });

    // Sin esto el corte tardaría hasta 30 s (el TTL de la caché). Y antes de
    // que existiera `AccountStateService` no llegaba nunca: borrar las filas
    // de `session` no invalidaba el access token ya emitido.
    this.accountState.invalidateUser(userId);
    this.accountState.invalidateAllSessions();

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
      throw new BadRequestException({
        message: `Rol "${roleName}" no asignable.`,
        code: 'ADMIN_ROLE_NOT_ASSIGNABLE',
        detail: roleName,
      });
    }
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
    });
    if (!user)
      throw new NotFoundException({
        message: 'Usuario no encontrado.',
        code: 'ADMIN_USER_NOT_FOUND',
      });

    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role)
      throw new BadRequestException({
        message: `Rol "${roleName}" no existe.`,
        code: 'ADMIN_ROLE_NOT_FOUND',
      });

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
    if (!user)
      throw new NotFoundException({
        message: 'Usuario no encontrado.',
        code: 'ADMIN_USER_NOT_FOUND',
      });

    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role)
      throw new BadRequestException({
        message: `Rol "${roleName}" no existe.`,
        code: 'ADMIN_ROLE_NOT_FOUND',
      });

    if (userId === actorId && roleName === 'tenant_admin') {
      throw new BadRequestException({
        message:
          'No puedes quitarte el rol tenant_admin a ti mismo (te quedarías sin acceso al panel).',
        code: 'ADMIN_USER_SELF_ROLE_REMOVAL_FORBIDDEN',
      });
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
   * Reenvía el email de "define tu contraseña" para usuarios PENDING o
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
    if (!user)
      throw new NotFoundException({
        message: 'Usuario no encontrado.',
        code: 'ADMIN_USER_NOT_FOUND',
      });

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant)
      throw new NotFoundException({
        message: 'Tenant no encontrado.',
        code: 'ADMIN_TENANT_NOT_FOUND',
      });

    // `allowPending: true` porque el use case típico de resend es justo para
    // users PENDING que no recibieron el primer email. Ver CORE-FIX-03.
    //
    // TTL de 7 días, no los 60 minutos del reset normal: esto es un enlace de
    // ALTA, no una petición que el usuario acaba de hacer. Nadie abre el correo
    // de bienvenida en la hora siguiente a recibirlo, y un enlace caducado en
    // una campaña de invitación significa perder al alumno en la puerta.
    await this.passwordReset.requestAndSendEmail(
      { email: user.email, resolvedTenantId: tenantId },
      webBaseUrl,
      ctx,
      { allowPending: true, ttlMinutes: INVITE_TTL_MINUTES, asInvitation: true },
    );

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
    externalSource: string | null;
    externalId: string | null;
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
      externalSource: user.externalSource,
      externalId: user.externalId,
    };
  }
}
