import { Injectable } from '@nestjs/common';
import type { ClientContext } from '../auth/client-context';
import { PrismaAuditLogService } from './prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleAccessInterceptor } from './module-access.interceptor';
import { ModuleRegistryService } from './module-registry.service';
import { ModuleContextFactory } from './module-context.factory';
import type { DidactaModule } from '@didacta/core-kernel';
import { randomUUID } from 'crypto';

const NO_CTX: ClientContext = { ip: null, userAgent: null };

export type TenantModulesErrorCode =
  | 'MODULE_NOT_FOUND'
  | 'TENANT_NOT_FOUND'
  | 'MODULE_HAS_ACTIVE_DEPENDENTS'
  | 'CORE_MODULE_NOT_DISABLEABLE';

export class TenantModulesError extends Error {
  constructor(
    public readonly code: TenantModulesErrorCode,
    message: string,
    public readonly metadata: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TenantModulesError';
  }
}

export interface TenantModuleListItem {
  name: string;
  version: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  enabledByDefault: boolean;
  /**
   * Si true, el módulo es categoría 'core' en su manifest y NO se puede
   * desactivar. La UI debe ocultar el toggle de activación; el backend
   * rechaza `disable()` con CORE_MODULE_NOT_DISABLEABLE. Esto cubre
   * theming/courses/learning/etc. — son arquitectónicamente core aunque
   * vivan en `modules/*` por estructura del repo.
   */
  isCore: boolean;
  dependencies: string[];
  dependents: string[];
  optionalDependencies: string[];
  enabledAt: string | null;
  updatedAt: string | null;
}

/**
 * HU-TA-002 — gestión de módulos por tenant.
 *
 * El registry mantiene los módulos cargados al boot (siempre los 7 disponibles
 * en proceso) y persiste el catálogo en la tabla `module`. Esta clase expone
 * el toggle por tenant: persiste estado en `tenant_module`, valida dependencias
 * antes de desactivar, registra audit log y emite eventos para que otros
 * subsistemas reaccionen.
 *
 * Reglas:
 *  - Estado efectivo = fila en `tenant_module` si existe; si no, `enabledByDefault`.
 *  - Desactivar un módulo del que dependen otros activos requiere `force=true`.
 *  - El estado se persiste pero NO bloquea endpoints todavía: el guard real
 *    queda como follow-up para evitar romper funcionalidad existente.
 */
@Injectable()
export class TenantModulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly auditLog: PrismaAuditLogService,
    private readonly accessCache: ModuleAccessInterceptor,
  ) {}

  async list(tenantId: string): Promise<TenantModuleListItem[]> {
    await this.ensureTenant(tenantId);

    const modules = this.registry.getRegistry().listModules();
    const rows = await this.prisma.module.findMany({
      where: { name: { in: modules.map((m) => m.manifest.name) } },
      include: {
        tenantModules: { where: { tenantId } },
      },
    });
    const byName = new Map(rows.map((r) => [r.name, r]));

    return modules.map((mod) => this.toListItem(mod, byName.get(mod.manifest.name), modules));
  }

  async enable(
    tenantId: string,
    moduleName: string,
    actorId: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantModuleListItem> {
    await this.ensureTenant(tenantId);
    const mod = this.requireModule(moduleName);

    const moduleRow = await this.prisma.module.findUniqueOrThrow({
      where: { name: moduleName },
    });
    const previous = await this.prisma.tenantModule.findUnique({
      where: { tenantId_moduleId: { tenantId, moduleId: moduleRow.id } },
    });

    if (previous?.enabled !== true) {
      await this.registry.getRegistry().enableForTenant(tenantId, moduleName);
    }

    await this.prisma.tenantModule.upsert({
      where: { tenantId_moduleId: { tenantId, moduleId: moduleRow.id } },
      update: { enabled: true },
      create: { tenantId, moduleId: moduleRow.id, enabled: true },
    });

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.module.enabled',
      resourceType: 'module',
      resourceId: moduleRow.id,
      metadata: { moduleName, version: moduleRow.version },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    await this.factory.getEventBus().publish({
      name: 'tenant.module.enabled',
      version: 1,
      data: { tenantId, moduleName, version: moduleRow.version },
      metadata: this.eventMeta(tenantId, actorId),
    });

    this.accessCache.invalidate(tenantId, moduleName);

    return this.findOne(tenantId, moduleName);
  }

  async disable(
    tenantId: string,
    moduleName: string,
    actorId: string,
    options: { force?: boolean } = {},
    ctx: ClientContext = NO_CTX,
  ): Promise<TenantModuleListItem> {
    await this.ensureTenant(tenantId);
    const mod = this.requireModule(moduleName);

    // Módulos categoría 'core' (theming, courses, learning, certificates,
    // assessments, community, billing, subscriptions) son arquitectónicamente
    // parte del producto base — no se desactivan aunque vivan en `modules/*`
    // por estructura del repo. Si alguien intenta desactivar uno (UI legacy,
    // script, llamada directa al API) lo bloqueamos acá.
    if (mod.manifest.category === 'core') {
      throw new TenantModulesError(
        'CORE_MODULE_NOT_DISABLEABLE',
        `El módulo "${moduleName}" es del core y no se puede desactivar.`,
        { moduleName, category: 'core' },
      );
    }

    const all = this.registry.getRegistry().listModules();
    const dependents = this.findActiveDependents(mod.manifest.name, all);
    const tenantState = await this.tenantStateMap(tenantId, all);
    const activeDependents = dependents.filter((d) => tenantState.get(d) === true);

    if (activeDependents.length > 0 && options.force !== true) {
      throw new TenantModulesError(
        'MODULE_HAS_ACTIVE_DEPENDENTS',
        `El módulo "${moduleName}" no se puede desactivar porque ${activeDependents.length} módulo(s) activo(s) dependen de él. Confirmá para desactivar también esos módulos.`,
        { dependents: activeDependents },
      );
    }

    const moduleRow = await this.prisma.module.findUniqueOrThrow({
      where: { name: moduleName },
    });
    const previous = await this.prisma.tenantModule.findUnique({
      where: { tenantId_moduleId: { tenantId, moduleId: moduleRow.id } },
    });
    const wasEnabled = previous ? previous.enabled : moduleRow.enabledByDefault;

    if (wasEnabled) {
      await this.registry.getRegistry().disableForTenant(tenantId, moduleName);
    }

    await this.prisma.tenantModule.upsert({
      where: { tenantId_moduleId: { tenantId, moduleId: moduleRow.id } },
      update: { enabled: false },
      create: { tenantId, moduleId: moduleRow.id, enabled: false },
    });

    // Cascade: desactivar también dependientes activos (con force).
    for (const depName of activeDependents) {
      await this.disable(tenantId, depName, actorId, { force: true }, ctx);
    }

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'admin.module.disabled',
      resourceType: 'module',
      resourceId: moduleRow.id,
      metadata: { moduleName, cascade: activeDependents },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    await this.factory.getEventBus().publish({
      name: 'tenant.module.disabled',
      version: 1,
      data: { tenantId, moduleName, cascade: activeDependents },
      metadata: this.eventMeta(tenantId, actorId),
    });

    this.accessCache.invalidate(tenantId, moduleName);
    for (const depName of activeDependents) {
      this.accessCache.invalidate(tenantId, depName);
    }

    return this.findOne(tenantId, moduleName);
  }

  private async findOne(tenantId: string, moduleName: string): Promise<TenantModuleListItem> {
    const list = await this.list(tenantId);
    const found = list.find((m) => m.name === moduleName);
    if (!found) {
      throw new TenantModulesError('MODULE_NOT_FOUND', `Módulo "${moduleName}" no encontrado.`);
    }
    return found;
  }

  private async ensureTenant(tenantId: string): Promise<void> {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) throw new TenantModulesError('TENANT_NOT_FOUND', 'Tenant no encontrado.');
  }

  private requireModule(name: string): DidactaModule {
    const mod = this.registry.getRegistry().getModule(name);
    if (!mod) {
      throw new TenantModulesError(
        'MODULE_NOT_FOUND',
        `Módulo "${name}" no está registrado en el core.`,
      );
    }
    return mod;
  }

  private findActiveDependents(target: string, all: readonly DidactaModule[]): string[] {
    return all
      .filter((m) => m.manifest.dependencies.modules.some((d) => d.name === target))
      .map((m) => m.manifest.name);
  }

  private async tenantStateMap(
    tenantId: string,
    modules: readonly DidactaModule[],
  ): Promise<Map<string, boolean>> {
    const rows = await this.prisma.module.findMany({
      where: { name: { in: modules.map((m) => m.manifest.name) } },
      include: { tenantModules: { where: { tenantId } } },
    });
    const map = new Map<string, boolean>();
    for (const row of rows) {
      const link = row.tenantModules[0];
      map.set(row.name, link ? link.enabled : row.enabledByDefault);
    }
    return map;
  }

  private toListItem(
    mod: DidactaModule,
    row:
      | {
          id: string;
          name: string;
          version: string;
          displayName: string;
          description: string | null;
          enabledByDefault: boolean;
          tenantModules: Array<{ enabled: boolean; enabledAt: Date; updatedAt: Date }>;
        }
      | undefined,
    all: readonly DidactaModule[],
  ): TenantModuleListItem {
    const link = row?.tenantModules[0];
    const enabled = link ? link.enabled : (row?.enabledByDefault ?? true);
    return {
      name: mod.manifest.name,
      version: mod.manifest.version,
      displayName: mod.manifest.displayName,
      description: mod.manifest.description ?? row?.description ?? null,
      enabled,
      enabledByDefault: row?.enabledByDefault ?? true,
      isCore: mod.manifest.category === 'core',
      dependencies: mod.manifest.dependencies.modules.map((d) => d.name),
      dependents: this.findActiveDependents(mod.manifest.name, all),
      optionalDependencies: mod.manifest.dependencies.optionalModules.map((d) => d.name),
      enabledAt: link ? link.enabledAt.toISOString() : null,
      updatedAt: link ? link.updatedAt.toISOString() : null,
    };
  }

  private eventMeta(tenantId: string, actorId: string) {
    return {
      tenantId,
      userId: actorId,
      timestamp: new Date().toISOString(),
      traceId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
  }
}
