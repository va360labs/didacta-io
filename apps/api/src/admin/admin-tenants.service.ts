/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { LICENSE_CAPABILITIES, LicenseService } from '@didacta/license-sdk';
import { updateThemeSchema } from '@didacta/mod-theming';
import { type AdminActor, auditActorId, auditActorTrace } from '../auth/admin-actor';
import type { ClientContext } from '../auth/client-context';
import { FIRST_ACCESS_TTL_MINUTES, PasswordResetService } from '../auth/password-reset.service';
import {
  type DeclaredCountryWriter,
  writeDeclaredCountry,
} from '../modules/payouts/declared-country';
import { PayoutsBrandingSync } from '../modules/payouts/payouts-branding.sync';
import { PayoutsRuntime } from '../modules/payouts/payouts-runtime.service';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { TenantStripeResolverService } from '../modules/tenant-stripe-resolver.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import type { GateState } from '../tenancy/subscription-gate';
import { SubscriptionGateService } from '../tenancy/subscription-gate.service';
import { runAsTenant, runGlobalWithoutTenant } from '../tenancy/tenant-context.storage';
import { brandToHex, hexToBrand } from './tenant-branding';
import {
  academyDateLocale,
  writeAcademyLocale,
  type AcademyLocale,
  type AcademyLocaleWriter,
} from '../common/academy-defaults';

const NO_CTX: ClientContext = { ip: null, userAgent: null };

/** Una regla automática del servidor (no una persona ni el plano de control). */
interface SystemActor {
  kind: 'system';
  /** Qué regla actúa (`video-inactivity`). */
  job: string;
  metadata: Record<string, unknown>;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOSTNAME_RE = /^[a-z0-9.-]{1,253}$/;

/**
 * Base del enlace del correo de bienvenida: fija, o función del id del aula
 * recién creada (la que usa la app, para que salga con el dominio del aula).
 */
export type WelcomeLinkBase = string | ((tenantId: string) => Promise<string> | string);

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
 * Información de capacidad multi-tenant para el panel super_admin.
 *
 * Semántica del 11º piloto License SDK (`feat:multi_tenant.real`):
 *  - Sin licencia EE: 1 tenant ACTIVE/SUSPENDED por instancia (el que creó
 *    el setup wizard al primer arranque). Crear un 2º devuelve 402.
 *  - Con licencia EE: ilimitado (limit = null).
 *  - `tenantCount` cuenta los tenants no soft-deleted (archivados sí cuentan
 *    porque siguen siendo recursos del tenant pool).
 */
export interface TenantCapacityInfo {
  tenantCount: number;
  /** null = ilimitado (EE activo). number = cap aplicado en CE. */
  limit: number | null;
  capabilityActive: boolean;
  capability: 'feat:multi_tenant.real';
  canCreate: boolean;
}

/** Capacidad CE: 1 tenant por instancia (el del setup wizard). */
const COMMUNITY_TENANT_LIMIT = 1;

/**
 * Consumo de un tenant a una fecha de corte. UC-C102.
 *
 * Lo consume el plano de control de Didacta Cloud para facturar por tramos, y
 * cualquier self-hoster que quiera saber qué gasta cada tenant de su
 * instalación. La definición de `activeMembers` vive en `getUsage()`.
 */
export interface TenantUsageItem {
  tenantId: string;
  slug: string;
  activeMembers: number;
  /** Fecha de corte aplicada, ISO-8601. Eco de la petición para que la factura sea auditable. */
  asOf: string;
}

/**
 * Respuesta de `PUT /admin/tenants/:id/subscription-gate`. Contrato con
 * `didacta-cloud` (ver `tests/contract/admin-tenants.contract.test.ts`).
 */
export interface SubscriptionGateResponse {
  tenantId: string;
  state: GateState;
  trialEndsAt: string | null;
  actionUrl: string | null;
  updatedAt: string | null;
}

export interface SubscriptionGateInput {
  state: GateState;
  trialEndsAt: string | null;
  actionUrl: string | null;
}

/**
 * Respuesta de `GET` y `PUT /admin/tenants/:id/branding`. Contrato con
 * `didacta-cloud` (ver `tests/contract/admin-tenants.contract.test.ts`).
 */
export interface TenantBrandingResponse {
  readonly name: string;
  /**
   * Color principal del aula tal como se pinta (`#rrggbb`, minúsculas), o
   * `null` si el aula no ha personalizado su marca (usa la de Didacta).
   */
  readonly primaryColor: string | null;
  readonly slug: string;
  /** Dominio primario del aula, o `null` si no tiene. */
  readonly primaryHostname: string | null;
}

export interface TenantBrandingInput {
  readonly name?: string;
  /** `#RRGGBB`. Se guarda como tono y saturación (la luminosidad es fija). */
  readonly primaryColor?: string;
}

/**
 * Roles que NO cuentan como miembro: son quien opera la academia, no quien la
 * consume. Cobrar por el administrador que da de alta a los demás sería cobrar
 * por el propio acto de administrar.
 */
const STAFF_ROLES: string[] = ['super_admin', 'tenant_admin'];

/**
 * Servicio CRUD para super_admin sobre la tabla `tenant`.
 *
 * HU-SA-001: alta de tenant + suspensión + asignación de dominios.
 *
 * Reglas:
 *  - Slug único, regex `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` (DNS-safe).
 *  - Al crear tenant también se crea el primer tenant_admin via email +
 *    se le envía el link de "define tu contraseña" reusando PasswordResetService.
 *  - Suspender un tenant invalida sessions de TODOS sus usuarios y bloquea
 *    futuros logins (ver AuthService.signin).
 */
@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly passwordReset: PasswordResetService,
    private readonly license: LicenseService,
    private readonly logger: PinoLogger,
    // Opcional para que los tests que montan el servicio a mano no tengan que
    // traerlo; en la app siempre está (TenancyModule es global).
    @Optional() private readonly subscriptionGate?: SubscriptionGateService,
    // Para avisar de que la cuenta de Stripe de instancia deja de heredarse al
    // pasar de una aula a varias. Opcional por lo mismo que el anterior.
    @Optional() private readonly stripeResolver?: TenantStripeResolverService,
    // Cobros de plataforma (solo existe con el modo encendido): al archivar un
    // aula se desconectan sus cobros (E6).
    @Optional() private readonly payouts?: PayoutsRuntime,
    // Marca del aula (`GET/PUT :id/branding`): el color vive en mod.theming.
    // Opcionales por lo mismo que los anteriores; sin registro no se puede
    // escribir el color (503), pero sí leerlo.
    @Optional() private readonly moduleRegistry?: ModuleRegistryService,
    // Solo con los cobros de plataforma: lleva la marca a la cuenta de Stripe.
    @Optional() private readonly paymentsBranding?: PayoutsBrandingSync,
  ) {}

  /**
   * Calcula si el operador puede crear un tenant adicional. Lo consume el
   * panel `/admin/tenants` para decidir entre mostrar el botón "Crear" o
   * el upsell card de Enterprise.
   *
   * El backend SIEMPRE re-comprueba dentro de `create()` — esto solo es UX.
   */
  async getCapacityInfo(): Promise<TenantCapacityInfo> {
    const tenantCount = await this.prisma.tenant.count({ where: { deletedAt: null } });
    const capabilityActive = this.license.isCapabilityEnabled(
      LICENSE_CAPABILITIES.MULTI_TENANT_REAL,
    );
    const limit = capabilityActive ? null : COMMUNITY_TENANT_LIMIT;
    const canCreate = capabilityActive ? true : tenantCount < COMMUNITY_TENANT_LIMIT;
    return {
      tenantCount,
      limit,
      capabilityActive,
      capability: LICENSE_CAPABILITIES.MULTI_TENANT_REAL,
      canCreate,
    };
  }

  async list(): Promise<TenantListItem[]> {
    // `runGlobalWithoutTenant` no es decorativo. `tenant` es tabla global, pero
    // `_count: { users }` y el groupBy de cursos pegan a tablas CON RLS, y esta
    // petición llega con contexto de tenant (el middleware lo resuelve por
    // Host). Sin salir del ALS, la extensión escopa esas dos subconsultas al
    // tenant desde el que mira el super_admin: el panel enseñaba los usuarios y
    // los cursos de SU tenant repetidos en todas las filas, sin error visible.
    const { tenants, courseCounts } = await runGlobalWithoutTenant(async () => ({
      tenants: await this.prisma.tenant.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        include: { domains: true, _count: { select: { users: true } } },
      }),
      // Course counts por tenant (consulta separada porque cursos viven en otra tabla).
      courseCounts: await this.prisma.modCoursesCourse.groupBy({
        by: ['tenantId'],
        _count: { id: true },
      }),
    }));
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
    // Mismo motivo que en list(): el _count de usuarios y el count de cursos
    // van contra tablas con RLS y esta petición trae contexto de otro tenant.
    const { t, courseCount } = await runGlobalWithoutTenant(async () => ({
      t: await this.prisma.tenant.findFirst({
        where: { id, deletedAt: null },
        include: { domains: true, _count: { select: { users: true } } },
      }),
      courseCount: await this.prisma.modCoursesCourse.count({ where: { tenantId: id } }),
    }));
    if (!t)
      throw new NotFoundException({
        message: 'Tenant no encontrado.',
        code: 'ADMIN_TENANT_NOT_FOUND',
      });

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
   * Miembros activos por tenant a una fecha de corte. UC-C102.
   *
   * Es la fuente de verdad de la facturación por tramos de Didacta Cloud, así
   * que la definición de «miembro activo» está aquí, en un solo sitio, y es la
   * misma que se publica en el Swagger y en la página de precios:
   *
   *   CUENTA     usuario con acceso al aula, activo y no borrado
   *   NO CUENTA  administradores del tenant (`tenant_admin`, `super_admin`),
   *              invitaciones nunca aceptadas (`PENDING`), suspendidos
   *              (`SUSPENDED`), bajas (`DEACTIVATED`) y borrados lógicos
   *
   * Formadores, auditores y gestores de empresa SÍ cuentan: consumen la
   * plataforma igual que un alumno. Si algún día cambia, se cambia aquí y en
   * los dos textos de cara al cliente, nunca solo en uno.
   */
  async getUsage(asOf?: Date): Promise<TenantUsageItem[]> {
    const cutoff = asOf ?? new Date();
    if (cutoff.getTime() > Date.now()) {
      throw new BadRequestException({
        message: 'La fecha de corte no puede estar en el futuro.',
        code: 'ADMIN_TENANT_USAGE_ASOF_IN_FUTURE',
      });
    }

    // Cross-tenant real: sin salir del ALS esto devuelve los usuarios de UN
    // solo tenant, o cero, y una factura calculada sobre eso es un cargo mal
    // hecho. Ver runGlobalWithoutTenant.
    return runGlobalWithoutTenant(async () => {
      const tenants = await this.prisma.tenant.findMany({
        where: { deletedAt: null, status: { not: 'ARCHIVED' } },
        select: { id: true, slug: true },
        orderBy: { createdAt: 'asc' },
      });

      const grouped = await this.prisma.user.groupBy({
        by: ['tenantId'],
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          createdAt: { lte: cutoff },
          NOT: { roles: { some: { role: { name: { in: STAFF_ROLES } } } } },
        },
        _count: { id: true },
      });
      const byTenant = new Map(grouped.map((g) => [g.tenantId, g._count.id]));

      return tenants.map((t) => ({
        tenantId: t.id,
        slug: t.slug,
        activeMembers: byTenant.get(t.id) ?? 0,
        asOf: cutoff.toISOString(),
      }));
    });
  }

  /**
   * Alta de tenant + primer tenant_admin + dominio primario.
   * El admin recibe email para definir contraseña (no se le da una temporal).
   *
   * `webBaseUrl` es la base del enlace de ese correo. Como función recibe el id
   * del aula ya creada, con su dominio primario dentro de la base: es lo que
   * pasa el controlador, para que el enlace apunte al aula nueva y no al
   * dominio desde el que llamó quien la crea.
   */
  async create(
    actor: AdminActor,
    dto: {
      slug: string;
      name: string;
      adminEmail: string;
      adminName?: string;
      primaryHostname: string;
      simpleMode?: boolean;
      locale?: AcademyLocale;
      /** País del banco DECLARADO en el alta de Cloud (ISO alfa-2 u `OTHER`), ya normalizado. */
      payoutsCountry?: string;
    },
    webBaseUrl: WelcomeLinkBase,
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantListItem> {
    // Toda la operación fuera del contexto de tenant, igual que el bootstrap
    // de `/setup/init`. El tenant que se crea NO es el de quien llama: sin
    // salir del ALS, el `set_config` que inyecta la extensión escopa la
    // transacción al tenant del super_admin y la policy `WITH CHECK
    // (tenant_id = current_tenant_id())` rechaza el `user` del tenant nuevo.
    // Con credencial de provisioning no hay contexto ninguno, y `didacta_app`
    // es NOBYPASSRLS: sin sancionar, tampoco vería una fila.
    return runGlobalWithoutTenant(() => this.createGlobal(actor, dto, webBaseUrl, ctx));
  }

  private async createGlobal(
    actor: AdminActor,
    dto: {
      slug: string;
      name: string;
      adminEmail: string;
      adminName?: string;
      primaryHostname: string;
      simpleMode?: boolean;
      locale?: AcademyLocale;
      /** País del banco DECLARADO en el alta de Cloud (ISO alfa-2 u `OTHER`), ya normalizado. */
      payoutsCountry?: string;
    },
    webBaseUrl: WelcomeLinkBase,
    ctx: ClientContext,
  ): Promise<TenantListItem> {
    if (!SLUG_RE.test(dto.slug)) {
      throw new BadRequestException({
        message:
          'El slug debe ser DNS-safe: minúsculas, números y guiones, sin empezar/terminar en guión, máx. 63 chars.',
        code: 'ADMIN_TENANT_SLUG_INVALID',
      });
    }
    const hostname = dto.primaryHostname.trim().toLowerCase();
    if (!HOSTNAME_RE.test(hostname)) {
      throw new BadRequestException({
        message: 'Hostname inválido.',
        code: 'ADMIN_TENANT_HOSTNAME_INVALID',
      });
    }

    // 11º piloto License SDK · `feat:multi_tenant.real`. La instancia community
    // permite UN tenant (el que crea el setup wizard al primer arranque).
    // Crear un 2º requiere licencia EE — sin ella, lanzamos
    // CapabilityRequiredError → el LicenseExceptionFilter lo serializa a
    // 402 Payment Required con `{ capability: "feat:multi_tenant.real" }`.
    const currentCount = await this.prisma.tenant.count({ where: { deletedAt: null } });
    if (currentCount >= COMMUNITY_TENANT_LIMIT) {
      this.license.requireCapability(LICENSE_CAPABILITIES.MULTI_TENANT_REAL);
    }

    const existingSlug = await this.prisma.tenant.findUnique({ where: { slug: dto.slug } });
    if (existingSlug) {
      throw new ConflictException({
        message: `Ya existe un tenant con slug "${dto.slug}".`,
        code: 'ADMIN_TENANT_SLUG_EXISTS',
        detail: dto.slug,
      });
    }
    const existingDomain = await this.prisma.tenantDomain.findUnique({ where: { hostname } });
    if (existingDomain) {
      throw new ConflictException({
        message: `El hostname "${hostname}" ya está asignado a otro tenant.`,
        code: 'ADMIN_TENANT_HOSTNAME_EXISTS',
      });
    }

    const tenantAdminRole = await this.prisma.role.findUnique({
      where: { name: 'tenant_admin' },
    });
    if (!tenantAdminRole) {
      throw new BadRequestException({
        message: 'Rol tenant_admin no existe en seed.',
        code: 'ADMIN_TENANT_ADMIN_ROLE_MISSING',
      });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          slug: dto.slug,
          name: dto.name,
          status: 'ACTIVE',
          simpleMode: resolveSimpleMode(actor, dto.simpleMode),
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
      // ACTIVE sin passwordHash: no puede entrar hasta definir contraseña con
      // el enlace del email, pero tampoco necesita que nadie le "reactive" el
      // acceso después. Mismo criterio que `AdminUsersService.invite`.
      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: dto.adminEmail,
          // El nombre que la creadora escribió en el alta (Didacta Cloud lo
          // manda como `adminName`): es el que sale en su perfil, en el saludo
          // del correo de bienvenida y en sus publicaciones.
          name: dto.adminName?.trim() || null,
          status: 'ACTIVE',
          // Con idioma del aula, la administradora nace en ese idioma: el correo
          // de bienvenida y su interfaz salen así desde el primer momento.
          ...(dto.locale ? { locale: academyDateLocale(dto.locale) } : {}),
        },
      });
      await tx.userRole.create({
        data: { userId: admin.id, roleId: tenantAdminRole.id },
      });
      if (dto.locale) {
        await writeAcademyLocale(
          tx as unknown as AcademyLocaleWriter,
          tenant.id,
          dto.locale,
          admin.id,
        );
      }
      // Dato DECLARADO por el creador, no verificado: solo orienta la tarjeta
      // de cobros (preselección y aviso). El país que cuenta es el de su cuenta.
      if (dto.payoutsCountry) {
        await writeDeclaredCountry(
          tx as unknown as DeclaredCountryWriter,
          tenant.id,
          dto.payoutsCountry,
          admin.id,
        );
      }
      return { tenant, admin };
    });

    await this.auditLog.record({
      tenantId: created.tenant.id,
      actorId: auditActorId(actor),
      action: 'admin.tenant.created',
      resourceType: 'tenant',
      resourceId: created.tenant.id,
      metadata: {
        slug: dto.slug,
        primaryHostname: hostname,
        adminEmail: dto.adminEmail,
        ...(dto.locale ? { locale: dto.locale } : {}),
        ...(dto.payoutsCountry ? { payoutsCountry: dto.payoutsCountry } : {}),
        ...auditActorTrace(actor),
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    // Con una segunda aula, la cuenta de Stripe de instancia deja de heredarse
    // por defecto y la PRIMERA deja de cobrar. Que quede dicho en el log en el
    // momento en que pasa, no cuando un alumno no pueda pagar.
    await this.stripeResolver?.reportGlobalFallback('tenant-created').catch(() => undefined);

    // Bienvenida de quien acaba de crear su academia: su propio correo («Tu
    // academia X está lista»), no el de «restablecer tu contraseña», y con la
    // validez de un primer acceso (7 días): lo puede abrir días después. Si
    // caduca, la pantalla del enlace le deja pedir otro con un clic.
    try {
      await this.passwordReset.requestAndSendEmail(
        { email: dto.adminEmail, resolvedTenantId: created.tenant.id },
        webBaseUrl,
        ctx,
        { ttlMinutes: FIRST_ACCESS_TTL_MINUTES, kind: 'academy_owner' },
      );
    } catch (err) {
      this.logger.warn(
        { err, tenantId: created.tenant.id },
        'admin.tenant.create: fallo al enviar email de bienvenida; el super_admin puede reenviar',
      );
    }

    return this.getDetail(created.tenant.id);
  }

  /**
   * Rename del tenant (`tenant.name`). Solo super_admin. No invalida sessions.
   *
   * Pensado para corregir el nombre del tenant después de creado — p. ej. al
   * pasar del "Didacta" genérico del bootstrap al nombre real de la academia.
   */
  async rename(
    actor: AdminActor,
    id: string,
    newName: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantListItem> {
    return runGlobalWithoutTenant(() => this.renameGlobal(actor, id, newName, ctx));
  }

  private async renameGlobal(
    actor: AdminActor,
    id: string,
    newName: string,
    ctx: ClientContext,
  ): Promise<TenantListItem> {
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException({
        message: 'El nombre del tenant no puede estar vacío.',
        code: 'ADMIN_TENANT_NAME_EMPTY',
      });
    }
    const t = await this.prisma.tenant.findFirst({ where: { id, deletedAt: null } });
    if (!t)
      throw new NotFoundException({
        message: 'Tenant no encontrado.',
        code: 'ADMIN_TENANT_NOT_FOUND',
      });

    await this.prisma.tenant.update({ where: { id }, data: { name: trimmed } });

    await this.auditLog.record({
      tenantId: id,
      actorId: auditActorId(actor),
      action: 'admin.tenant.renamed',
      resourceType: 'tenant',
      resourceId: id,
      metadata: { previousName: t.name, newName: trimmed, ...auditActorTrace(actor) },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return this.getDetail(id);
  }

  async setStatus(
    actor: AdminActor,
    id: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED',
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantListItem> {
    // `session` lleva RLS: sin salir del contexto, el deleteMany de abajo
    // borraba cero filas en silencio y el tenant suspendido se quedaba con
    // todas sus sesiones vivas.
    return runGlobalWithoutTenant(() => this.setStatusGlobal(actor, id, status, ctx));
  }

  /**
   * Archiva un aula por una regla automática del servidor (sin persona ni
   * credencial detrás): hoy, la política de inactividad del vídeo de Didacta
   * Cloud. Hace EXACTAMENTE lo mismo que archivar desde el panel (cierra las
   * sesiones, desconecta los cobros, audita); en el audit log el actor queda
   * vacío y `metadata` dice qué regla fue (`actorKind: 'system'`, `job`).
   */
  async archiveBySystem(
    id: string,
    job: string,
    metadata: Record<string, unknown> = {},
  ): Promise<TenantListItem> {
    return runGlobalWithoutTenant(() =>
      this.setStatusGlobal({ kind: 'system', job, metadata }, id, 'ARCHIVED', NO_CTX),
    );
  }

  private async setStatusGlobal(
    actor: AdminActor | SystemActor,
    id: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED',
    ctx: ClientContext,
  ): Promise<TenantListItem> {
    const t = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
    });
    if (!t)
      throw new NotFoundException({
        message: 'Tenant no encontrado.',
        code: 'ADMIN_TENANT_NOT_FOUND',
      });

    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id }, data: { status } });
      // Si suspendemos o archivamos, invalidar sessions activas de todos los users.
      if (status !== 'ACTIVE') {
        await tx.session.deleteMany({
          where: { tenantId: id, expiresAt: { gt: new Date() } },
        });
      }
    });

    // Baja del creador (E6): sin ventas nuevas y sus suscripciones a fin de
    // periodo. La cuenta de Stripe no se cierra (disputas: 120 días) y lo
    // pendiente se le sigue pagando. Un fallo aquí no deshace el archivado:
    // queda en el log y se puede repetir desde el panel del aula.
    let payoutsOffboarding: Record<string, unknown> | null = null;
    if (status === 'ARCHIVED' && t.status !== 'ARCHIVED' && this.payouts) {
      try {
        const result = await this.payouts.offboarding.disconnect(id, {
          reason: 'tenant_archived',
        });
        payoutsOffboarding = {
          changed: result.changed,
          subscriptionsScheduled: result.subscriptionsScheduled,
          subscriptionsFailed: result.subscriptionsFailed,
        };
      } catch (err) {
        payoutsOffboarding = { error: err instanceof Error ? err.message.slice(0, 200) : 'error' };
        this.logger.error(
          { err, tenantId: id },
          'payouts.offboarding_failed: no se pudieron desconectar los cobros del aula archivada',
        );
      }
    }

    await this.auditLog.record({
      tenantId: id,
      actorId: actor.kind === 'system' ? null : auditActorId(actor),
      action: `admin.tenant.status_changed.${status.toLowerCase()}`,
      resourceType: 'tenant',
      resourceId: id,
      metadata: {
        previousStatus: t.status,
        newStatus: status,
        ...(payoutsOffboarding ? { payoutsOffboarding } : {}),
        ...(actor.kind === 'system'
          ? { actorKind: 'system', job: actor.job, ...actor.metadata }
          : auditActorTrace(actor)),
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return this.getDetail(id);
  }

  /**
   * Congela o descongela las altas nuevas del tenant (U7).
   *
   * Es un interruptor y nada mas: aqui no se cuenta a nadie ni se mira ninguna
   * licencia. La politica que decide congelar vive fuera —en la persona que
   * pulsa, o en el plano de control del SaaS—, nunca en el nucleo. Ver
   * `tenancy/signup-freeze.ts`.
   */
  async setSignupsFrozen(
    actor: AdminActor,
    id: string,
    frozen: boolean,
    reason: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantListItem> {
    return runGlobalWithoutTenant(async () => {
      const t = await this.prisma.tenant.findFirst({ where: { id, deletedAt: null } });
      if (!t)
        throw new NotFoundException({
          message: 'Tenant no encontrado.',
          code: 'ADMIN_TENANT_NOT_FOUND',
        });

      await this.prisma.tenant.update({
        where: { id },
        data: {
          signupsFrozenAt: frozen ? new Date() : null,
          signupsFrozenReason: frozen ? reason : null,
        },
      });

      await this.auditLog.record({
        tenantId: id,
        actorId: auditActorId(actor),
        action: frozen ? 'admin.tenant.signups_frozen' : 'admin.tenant.signups_unfrozen',
        resourceType: 'tenant',
        resourceId: id,
        metadata: { reason, ...auditActorTrace(actor) },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });

      return this.getDetail(id);
    });
  }

  /**
   * Mueve la puerta de suscripción del tenant. No toca `status`: el aula en
   * pausa sigue ACTIVE para que su administrador pueda entrar y pagar. Ver
   * `tenancy/subscription-gate.ts`.
   *
   * Idempotente de verdad: si lo pedido ya es lo que hay, no escribe, no deja
   * fila en el audit log y devuelve el `updatedAt` de antes. El plano de control
   * puede repetir la llamada todas las veces que quiera.
   */
  async setSubscriptionGate(
    actor: AdminActor,
    id: string,
    input: SubscriptionGateInput,
    ctx: ClientContext = NO_CTX,
  ): Promise<SubscriptionGateResponse> {
    return runGlobalWithoutTenant(async () => {
      const t = await this.prisma.tenant.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          subscriptionGateState: true,
          subscriptionTrialEndsAt: true,
          subscriptionActionUrl: true,
          subscriptionGateUpdatedAt: true,
        },
      });
      if (!t)
        throw new NotFoundException({
          message: 'Tenant no encontrado.',
          code: 'ADMIN_TENANT_NOT_FOUND',
        });

      // OPEN borra fecha y enlace: un aula abierta no tiene prueba ni pago pendiente.
      const open = input.state === 'OPEN';
      const trialEndsAt = open || !input.trialEndsAt ? null : new Date(input.trialEndsAt);
      const actionUrl = open ? null : input.actionUrl;

      const unchanged =
        t.subscriptionGateState === input.state &&
        (t.subscriptionTrialEndsAt?.getTime() ?? null) === (trialEndsAt?.getTime() ?? null) &&
        t.subscriptionActionUrl === actionUrl;

      let updatedAt = t.subscriptionGateUpdatedAt;
      if (!unchanged) {
        updatedAt = new Date();
        await this.prisma.tenant.update({
          where: { id },
          data: {
            subscriptionGateState: input.state,
            subscriptionTrialEndsAt: trialEndsAt,
            subscriptionActionUrl: actionUrl,
            subscriptionGateUpdatedAt: updatedAt,
          },
        });
        this.subscriptionGate?.invalidate();

        await this.auditLog.record({
          tenantId: id,
          actorId: auditActorId(actor),
          action: `admin.tenant.subscription_gate.${input.state.toLowerCase()}`,
          resourceType: 'tenant',
          resourceId: id,
          // El enlace lleva el token de pago de la cuenta: no se copia al log,
          // basta con saber si había uno.
          metadata: {
            previousState: t.subscriptionGateState,
            newState: input.state,
            trialEndsAt: trialEndsAt?.toISOString() ?? null,
            hasActionUrl: actionUrl !== null,
            ...auditActorTrace(actor),
          },
          ip: ctx.ip ?? undefined,
          userAgent: ctx.userAgent ?? undefined,
        });
      }

      return {
        tenantId: id,
        state: input.state,
        trialEndsAt: trialEndsAt?.toISOString() ?? null,
        actionUrl,
        updatedAt: updatedAt?.toISOString() ?? null,
      };
    });
  }

  async addDomain(
    actor: AdminActor,
    tenantId: string,
    hostname: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantListItem> {
    return runGlobalWithoutTenant(() => this.addDomainGlobal(actor, tenantId, hostname, ctx));
  }

  private async addDomainGlobal(
    actor: AdminActor,
    tenantId: string,
    hostname: string,
    ctx: ClientContext,
  ): Promise<TenantListItem> {
    const host = hostname.trim().toLowerCase();
    if (!HOSTNAME_RE.test(host)) {
      throw new BadRequestException({
        message: 'Hostname inválido.',
        code: 'ADMIN_TENANT_HOSTNAME_INVALID',
      });
    }
    const existing = await this.prisma.tenantDomain.findUnique({ where: { hostname: host } });
    if (existing) {
      throw new ConflictException({
        message: `El hostname "${host}" ya está asignado (al mismo o a otro tenant).`,
        code: 'ADMIN_TENANT_HOSTNAME_EXISTS',
      });
    }
    await this.prisma.tenantDomain.create({
      data: { tenantId, hostname: host, isPrimary: false, isVerified: true },
    });
    await this.auditLog.record({
      tenantId,
      actorId: auditActorId(actor),
      action: 'admin.tenant.domain_added',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { hostname: host, ...auditActorTrace(actor) },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return this.getDetail(tenantId);
  }

  async removeDomain(
    actor: AdminActor,
    tenantId: string,
    hostname: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantListItem> {
    return runGlobalWithoutTenant(() => this.removeDomainGlobal(actor, tenantId, hostname, ctx));
  }

  private async removeDomainGlobal(
    actor: AdminActor,
    tenantId: string,
    hostname: string,
    ctx: ClientContext,
  ): Promise<TenantListItem> {
    const host = hostname.trim().toLowerCase();
    const domain = await this.prisma.tenantDomain.findFirst({
      where: { tenantId, hostname: host },
    });
    if (!domain) {
      throw new NotFoundException({
        message: 'Dominio no encontrado en este tenant.',
        code: 'ADMIN_TENANT_DOMAIN_NOT_FOUND',
      });
    }
    if (domain.isPrimary) {
      throw new BadRequestException({
        message: 'No puedes eliminar el dominio primario. Asigna otro como primario antes.',
        code: 'ADMIN_TENANT_PRIMARY_DOMAIN_DELETE_FORBIDDEN',
      });
    }
    await this.prisma.tenantDomain.delete({ where: { id: domain.id } });
    await this.auditLog.record({
      tenantId,
      actorId: auditActorId(actor),
      action: 'admin.tenant.domain_removed',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { hostname: host, ...auditActorTrace(actor) },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return this.getDetail(tenantId);
  }

  /**
   * Nombre y color de un aula, para el panel del creador de Didacta Cloud.
   * Solo lectura: no crea el tema si no existe (`primaryColor: null`).
   */
  async getBranding(id: string): Promise<TenantBrandingResponse> {
    const tenant = await runGlobalWithoutTenant(() =>
      this.prisma.tenant.findFirst({
        where: { id, deletedAt: null },
        select: { name: true, slug: true },
      }),
    );
    if (!tenant) {
      throw new NotFoundException({
        message: 'Tenant no encontrado.',
        code: 'ADMIN_TENANT_NOT_FOUND',
      });
    }
    // Tema y dominio llevan RLS por aula: se leen con el contexto del aula
    // pedida (como `TenantResolverService.resolvePrimaryDomain`). Medido contra
    // Postgres con RLS forzada: la relación `domains` anidada en la consulta
    // global del tenant volvía VACÍA, y `primaryHostname` salía `null`.
    const [theme, primary] = await runAsTenant(id, () =>
      Promise.all([
        this.prisma.modThemingTenantTheme.findUnique({
          where: { tenantId: id },
          select: { brandHue: true, brandSaturation: true },
        }),
        this.prisma.tenantDomain.findFirst({
          where: { tenantId: id, isPrimary: true },
          select: { hostname: true },
        }),
      ]),
    );
    return {
      name: tenant.name,
      primaryColor: theme ? brandToHex(theme.brandHue, theme.brandSaturation) : null,
      slug: tenant.slug,
      primaryHostname: primary?.hostname ?? null,
    };
  }

  /**
   * Cambia el nombre y/o el color de un aula. Idempotente: lo que ya es lo
   * pedido no se escribe ni deja fila en el audit log.
   *
   * El nombre sigue EXACTAMENTE el camino de `rename` (mismo audit log
   * `admin.tenant.renamed`, con el actor de máquina marcado): esta es la única
   * puerta por la que la credencial de provisioning puede renombrar, y solo
   * con la marca. `PATCH :id` sigue sin abrirse a la máquina.
   *
   * El color pasa por el servicio de theming del módulo (`updateThemeSchema`)
   * como tono y saturación; ver `tenant-branding.ts`. Todo se valida ANTES de
   * escribir nada, para no dejar un nombre cambiado con un color que falla.
   */
  async setBranding(
    actor: AdminActor,
    id: string,
    input: TenantBrandingInput,
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantBrandingResponse> {
    const current = await this.getBranding(id);
    const color =
      input.primaryColor !== undefined
        ? updateThemeSchema.parse(hexToBrand(input.primaryColor))
        : null;
    if (color && !this.moduleRegistry) {
      throw new ServiceUnavailableException({
        message: 'El servicio de marca del aula no está disponible.',
        code: 'ADMIN_TENANT_BRANDING_UNAVAILABLE',
      });
    }

    let changed = false;
    const name = input.name?.trim();
    if (name !== undefined && name !== current.name) {
      await this.rename(actor, id, name, ctx);
      changed = true;
    }

    if (color && this.moduleRegistry) {
      const nextHex = brandToHex(color.brandHue ?? 0, color.brandSaturation ?? 0);
      // Devolver tal cual el hex que se acaba de leer no es un cambio: sin esta
      // comprobación, el redondeo a 8 bits por canal haría derivar el aula un
      // paso en cada «guardar lo que ya hay».
      const sameAsRead = input.primaryColor?.toLowerCase() === current.primaryColor;
      if (!sameAsRead && nextHex !== current.primaryColor) {
        const registry = this.moduleRegistry;
        await runAsTenant(id, () => registry.getThemingService().update(id, color));
        await runAsTenant(id, () =>
          this.auditLog.record({
            tenantId: id,
            actorId: auditActorId(actor),
            action: 'admin.tenant.branding_color_changed',
            resourceType: 'tenant',
            resourceId: id,
            metadata: {
              previousColor: current.primaryColor,
              color: nextHex,
              ...auditActorTrace(actor),
            },
            ip: ctx.ip ?? undefined,
            userAgent: ctx.userAgent ?? undefined,
          }),
        );
        changed = true;
      }
    }

    // Stripe enseña el nombre y el color del aula: que se enteren. En segundo
    // plano y solo con los cobros de plataforma encendidos.
    if (changed) this.paymentsBranding?.request(id);
    return this.getBranding(id);
  }
}

/**
 * ¿Nace el aula en modo sencillo?
 *
 * Lo pedido explícitamente manda. Sin pedirlo: las aulas que crea el plano de
 * control del SaaS (Didacta Cloud, credencial de provisioning) nacen en modo
 * sencillo, y las que crea un super_admin de una instalación propia, en modo
 * completo, que es lo que tenían todas antes de existir el ajuste.
 */
export function resolveSimpleMode(actor: AdminActor, requested: boolean | undefined): boolean {
  if (requested !== undefined) return requested;
  return actor.kind === 'provisioning';
}
