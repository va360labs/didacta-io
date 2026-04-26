import semver from 'semver';
import type { DidactaModule, ModuleContext, Logger } from '@didacta/core-kernel';
import { resolveDependencyOrder } from './dependency-resolver.js';

export class CoreVersionMismatchError extends Error {
  constructor(
    public readonly moduleName: string,
    public readonly requiredRange: string,
    public readonly coreVersion: string,
  ) {
    super(
      `El módulo "${moduleName}" requiere core@${requiredRange}, pero el core actual es ${coreVersion}`,
    );
    this.name = 'CoreVersionMismatchError';
  }
}

export interface ModuleRegistryOptions {
  coreVersion: string;
  context: ModuleContext;
  logger?: Logger;
}

type ModuleState = 'registered' | 'enabled' | 'disabled' | 'uninstalled';

interface TenantModuleState {
  tenantId: string;
  moduleName: string;
  state: ModuleState;
}

/**
 * Registry central del core. Mantiene la colección de módulos cargados y
 * coordina su ciclo de vida (register, enable, disable, uninstall).
 *
 * No conoce detalles de persistencia (el core-tenancy aplicará las transiciones
 * sobre `tenant_module` en BD).
 */
export class ModuleRegistry {
  private readonly modules = new Map<string, DidactaModule>();
  private readonly tenantState = new Map<string, TenantModuleState>();
  private readonly context: ModuleContext;
  private readonly coreVersion: string;
  private readonly logger: Logger | undefined;
  private registered = false;

  constructor(options: ModuleRegistryOptions) {
    this.context = options.context;
    this.coreVersion = options.coreVersion;
    this.logger = options.logger;
  }

  /**
   * Registra una colección de módulos. Valida versiones, resuelve dependencias
   * y ejecuta `onRegister` en orden topológico.
   */
  async register(modules: readonly DidactaModule[]): Promise<void> {
    if (this.registered) {
      throw new Error('El registry ya fue inicializado. No se pueden registrar módulos dos veces.');
    }

    for (const mod of modules) {
      if (!semver.satisfies(this.coreVersion, mod.manifest.coreVersionRequired)) {
        throw new CoreVersionMismatchError(
          mod.manifest.name,
          mod.manifest.coreVersionRequired,
          this.coreVersion,
        );
      }
    }

    const ordered = resolveDependencyOrder(modules);

    for (const mod of ordered) {
      this.logger?.info('Registrando módulo', {
        name: mod.manifest.name,
        version: mod.manifest.version,
      });
      await mod.onRegister(this.context);
      this.modules.set(mod.manifest.name, mod);
    }

    this.registered = true;
  }

  getModule(name: string): DidactaModule | undefined {
    return this.modules.get(name);
  }

  listModules(): readonly DidactaModule[] {
    return Array.from(this.modules.values());
  }

  getTenantState(tenantId: string, moduleName: string): ModuleState | undefined {
    return this.tenantState.get(this.key(tenantId, moduleName))?.state;
  }

  async enableForTenant(tenantId: string, moduleName: string): Promise<void> {
    const mod = this.ensureModule(moduleName);
    const currentState = this.getTenantState(tenantId, moduleName);
    if (currentState === 'enabled') return;

    this.logger?.info('Activando módulo en tenant', { tenantId, moduleName });
    await mod.onEnable(tenantId, this.context);
    this.tenantState.set(this.key(tenantId, moduleName), {
      tenantId,
      moduleName,
      state: 'enabled',
    });
  }

  async disableForTenant(tenantId: string, moduleName: string): Promise<void> {
    const mod = this.ensureModule(moduleName);
    const currentState = this.getTenantState(tenantId, moduleName);
    if (currentState !== 'enabled') return;

    this.logger?.info('Desactivando módulo en tenant', { tenantId, moduleName });
    await mod.onDisable(tenantId, this.context);
    this.tenantState.set(this.key(tenantId, moduleName), {
      tenantId,
      moduleName,
      state: 'disabled',
    });
  }

  async uninstallForTenant(tenantId: string, moduleName: string): Promise<void> {
    const mod = this.ensureModule(moduleName);
    const currentState = this.getTenantState(tenantId, moduleName);
    if (currentState === 'uninstalled') return;

    this.logger?.info('Desinstalando módulo en tenant', { tenantId, moduleName });
    await mod.onUninstall(tenantId, this.context);
    this.tenantState.set(this.key(tenantId, moduleName), {
      tenantId,
      moduleName,
      state: 'uninstalled',
    });
  }

  private ensureModule(name: string): DidactaModule {
    const mod = this.modules.get(name);
    if (!mod) throw new Error(`Módulo "${name}" no está registrado`);
    return mod;
  }

  private key(tenantId: string, moduleName: string): string {
    return `${tenantId}::${moduleName}`;
  }
}
