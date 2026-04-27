import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DidactaModule, ModuleManifest } from '@didacta/core-kernel';
import { TenantModulesError, TenantModulesService } from '../src/modules/tenant-modules.service';

interface ModuleRow {
  id: string;
  name: string;
  version: string;
  displayName: string;
  description: string | null;
  enabledByDefault: boolean;
  manifest: object;
}
interface TenantModuleRow {
  tenantId: string;
  moduleId: string;
  enabled: boolean;
  enabledAt: Date;
  updatedAt: Date;
}

function manifest(name: string, deps: string[] = [], optionalDeps: string[] = []): ModuleManifest {
  return {
    name: name as ModuleManifest['name'],
    displayName: name,
    description: `${name} description`,
    version: '1.0.0',
    coreVersionRequired: '^1.0.0',
    dependencies: {
      modules: deps.map((d) => ({ name: d, version: '^1.0.0' })),
      optionalModules: optionalDeps.map((d) => ({ name: d, version: '^1.0.0' })),
    },
    tablePrefix: `${name.replace('mod.', 'mod_').replace('-', '_')}_`,
    permissions: [],
    roles: [],
    eventsEmitted: [],
    eventsConsumed: [],
    hooksExposed: [],
    hooksConsumed: [],
    defaultConfig: {},
    uiExtensions: [],
    pages: [],
    apiNamespace: `/modules/${name.replace('mod.', '')}`,
  } as ModuleManifest;
}

function fakeModule(name: string, deps: string[] = [], optionalDeps: string[] = []): DidactaModule {
  return {
    manifest: manifest(name, deps, optionalDeps),
    onRegister: vi.fn(),
    onEnable: vi.fn(),
    onDisable: vi.fn(),
    onUninstall: vi.fn(),
  };
}

function setup(modules: DidactaModule[], tenantExists = true) {
  const moduleRows: ModuleRow[] = modules.map((m, i) => ({
    id: `mid-${i}`,
    name: m.manifest.name,
    version: m.manifest.version,
    displayName: m.manifest.displayName,
    description: m.manifest.description ?? null,
    enabledByDefault: true,
    manifest: m.manifest as unknown as object,
  }));
  const tenantModuleRows: TenantModuleRow[] = [];
  const tenantId = 't1';

  const prisma = {
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        tenantExists && where.id === tenantId ? { id: tenantId } : null,
      ),
    },
    module: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { name: string } }) => {
        const r = moduleRows.find((m) => m.name === where.name);
        if (!r) throw new Error(`module ${where.name} not found in fake`);
        return r;
      }),
      findMany: vi.fn(async ({ where, include }: any) => {
        const names: string[] = where?.name?.in ?? moduleRows.map((m) => m.name);
        return moduleRows
          .filter((m) => names.includes(m.name))
          .map((m) => ({
            ...m,
            tenantModules: include?.tenantModules
              ? tenantModuleRows.filter(
                  (tm) =>
                    tm.tenantId === include.tenantModules.where.tenantId && tm.moduleId === m.id,
                )
              : [],
          }));
      }),
    },
    tenantModule: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { tenantId: tid, moduleId } = where.tenantId_moduleId;
        return (
          tenantModuleRows.find((tm) => tm.tenantId === tid && tm.moduleId === moduleId) ?? null
        );
      }),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const { tenantId: tid, moduleId } = where.tenantId_moduleId;
        const existing = tenantModuleRows.find(
          (tm) => tm.tenantId === tid && tm.moduleId === moduleId,
        );
        const now = new Date();
        if (existing) {
          existing.enabled = update.enabled;
          existing.updatedAt = now;
          return existing;
        }
        const row = { ...create, enabledAt: now, updatedAt: now };
        tenantModuleRows.push(row);
        return row;
      }),
    },
  } as never;

  const enableForTenant = vi.fn(async (_t: string, _n: string) => {});
  const disableForTenant = vi.fn(async (_t: string, _n: string) => {});
  const registryService = {
    getRegistry: () => ({
      listModules: () => modules,
      getModule: (name: string) => modules.find((m) => m.manifest.name === name),
      enableForTenant,
      disableForTenant,
    }),
  } as never;

  const publish = vi.fn(async () => {});
  const factory = {
    getEventBus: () => ({ publish }),
  } as never;

  const auditLog = {
    record: vi.fn(async () => {}),
  } as never;

  const accessCache = {
    invalidate: vi.fn(),
  } as never;

  const service = new TenantModulesService(prisma, registryService, factory, auditLog, accessCache);

  return {
    service,
    prisma,
    tenantModuleRows,
    enableForTenant,
    disableForTenant,
    publish,
    auditLog,
    accessCache,
  };
}

describe('TenantModulesService.list', () => {
  it('devuelve cada módulo con estado default true cuando no hay fila tenant_module', async () => {
    const modules = [fakeModule('mod.a'), fakeModule('mod.b')];
    const { service } = setup(modules);
    const list = await service.list('t1');
    expect(list).toHaveLength(2);
    expect(list.every((m) => m.enabled === true)).toBe(true);
    expect(list.every((m) => m.enabledByDefault === true)).toBe(true);
  });

  it('refleja el estado de la fila tenant_module si existe', async () => {
    const modules = [fakeModule('mod.a'), fakeModule('mod.b')];
    const ctx = setup(modules);
    await ctx.service.disable('t1', 'mod.a', 'u1');
    const list = await ctx.service.list('t1');
    expect(list.find((m) => m.name === 'mod.a')?.enabled).toBe(false);
    expect(list.find((m) => m.name === 'mod.b')?.enabled).toBe(true);
  });

  it('expone dependencies y dependents derivados de los manifests', async () => {
    const modules = [fakeModule('mod.a'), fakeModule('mod.b', ['mod.a'])];
    const { service } = setup(modules);
    const list = await service.list('t1');
    const a = list.find((m) => m.name === 'mod.a')!;
    const b = list.find((m) => m.name === 'mod.b')!;
    expect(a.dependents).toEqual(['mod.b']);
    expect(b.dependencies).toEqual(['mod.a']);
  });

  it('lanza TENANT_NOT_FOUND si el tenant no existe', async () => {
    const modules = [fakeModule('mod.a')];
    const { service } = setup(modules, false);
    await expect(service.list('t1')).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
    });
  });
});

describe('TenantModulesService.enable', () => {
  it('llama al registry, persiste enabled=true, audita y emite evento', async () => {
    const modules = [fakeModule('mod.a')];
    const ctx = setup(modules);
    const result = await ctx.service.enable('t1', 'mod.a', 'u1');

    expect(ctx.enableForTenant).toHaveBeenCalledWith('t1', 'mod.a');
    expect(ctx.tenantModuleRows[0]?.enabled).toBe(true);
    expect(ctx.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.module.enabled', tenantId: 't1' }),
    );
    expect(ctx.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'tenant.module.enabled' }),
    );
    expect(result.enabled).toBe(true);
  });

  it('es idempotente: si ya estaba enabled, NO vuelve a invocar onEnable del registry', async () => {
    const modules = [fakeModule('mod.a')];
    const ctx = setup(modules);
    await ctx.service.enable('t1', 'mod.a', 'u1');
    ctx.enableForTenant.mockClear();
    await ctx.service.enable('t1', 'mod.a', 'u1');
    expect(ctx.enableForTenant).not.toHaveBeenCalled();
  });

  it('lanza MODULE_NOT_FOUND si el módulo no existe en el registry', async () => {
    const modules = [fakeModule('mod.a')];
    const { service } = setup(modules);
    await expect(service.enable('t1', 'mod.unknown', 'u1')).rejects.toMatchObject({
      code: 'MODULE_NOT_FOUND',
    });
  });
});

describe('TenantModulesService.disable', () => {
  it('persiste enabled=false, llama al registry y emite evento', async () => {
    const modules = [fakeModule('mod.a')];
    const ctx = setup(modules);
    await ctx.service.disable('t1', 'mod.a', 'u1');

    expect(ctx.disableForTenant).toHaveBeenCalledWith('t1', 'mod.a');
    expect(ctx.tenantModuleRows[0]?.enabled).toBe(false);
    expect(ctx.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'tenant.module.disabled' }),
    );
  });

  it('rechaza con MODULE_HAS_ACTIVE_DEPENDENTS si hay dependientes activos sin force', async () => {
    const modules = [fakeModule('mod.a'), fakeModule('mod.b', ['mod.a'])];
    const { service } = setup(modules);
    await expect(service.disable('t1', 'mod.a', 'u1')).rejects.toMatchObject({
      code: 'MODULE_HAS_ACTIVE_DEPENDENTS',
      metadata: { dependents: ['mod.b'] },
    });
  });

  it('con force=true desactiva en cascada el dependiente', async () => {
    const modules = [fakeModule('mod.a'), fakeModule('mod.b', ['mod.a'])];
    const ctx = setup(modules);
    await ctx.service.disable('t1', 'mod.a', 'u1', { force: true });
    const list = await ctx.service.list('t1');
    expect(list.find((m) => m.name === 'mod.a')?.enabled).toBe(false);
    expect(list.find((m) => m.name === 'mod.b')?.enabled).toBe(false);
  });

  it('si el dependiente ya está desactivado, no bloquea (no hay dependientes activos)', async () => {
    const modules = [fakeModule('mod.a'), fakeModule('mod.b', ['mod.a'])];
    const ctx = setup(modules);
    await ctx.service.disable('t1', 'mod.b', 'u1');
    await expect(ctx.service.disable('t1', 'mod.a', 'u1')).resolves.toBeDefined();
  });

  it('ignora optionalModules para el cálculo de dependencias bloqueantes', async () => {
    const modules = [fakeModule('mod.a'), fakeModule('mod.b', [], ['mod.a'])];
    const { service } = setup(modules);
    await expect(service.disable('t1', 'mod.a', 'u1')).resolves.toBeDefined();
  });

  it('audita la acción con cascade en metadata', async () => {
    const modules = [fakeModule('mod.a'), fakeModule('mod.b', ['mod.a'])];
    const ctx = setup(modules);
    await ctx.service.disable('t1', 'mod.a', 'u1', { force: true });
    expect(ctx.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.module.disabled',
        metadata: expect.objectContaining({ moduleName: 'mod.a', cascade: ['mod.b'] }),
      }),
    );
  });
});
