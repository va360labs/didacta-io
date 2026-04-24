import type { LearnShipModule, ModuleContext, ModuleManifest } from '@learnship/core-kernel';
import { vi } from 'vitest';

export function mockContext(): ModuleContext {
  return {
    eventBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
    hookRegistry: { register: vi.fn(), run: vi.fn() } as never,
    storage: {} as never,
    auditLog: { record: vi.fn() } as never,
    evidenceVault: { store: vi.fn() } as never,
    notificationHub: { send: vi.fn() } as never,
    i18n: { t: (key: string) => key } as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(function child() {
        return mockContext().logger;
      }),
    },
    config: { get: vi.fn(), set: vi.fn() } as never,
  };
}

export function buildManifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  const name = overrides.name ?? 'mod.test';
  const prefix = name === 'core' ? 'mod_core_' : `${name.replace(/\./g, '_').replace(/-/g, '_')}_`;
  return {
    name,
    displayName: overrides.displayName ?? name,
    description: overrides.description ?? 'test',
    version: overrides.version ?? '1.0.0',
    coreVersionRequired: overrides.coreVersionRequired ?? '^1.0.0',
    dependencies: overrides.dependencies ?? { modules: [], optionalModules: [] },
    tablePrefix: overrides.tablePrefix ?? prefix,
    permissions: overrides.permissions ?? [],
    roles: overrides.roles ?? [],
    eventsEmitted: overrides.eventsEmitted ?? [],
    eventsConsumed: overrides.eventsConsumed ?? [],
    hooksExposed: overrides.hooksExposed ?? [],
    hooksConsumed: overrides.hooksConsumed ?? [],
    defaultConfig: overrides.defaultConfig ?? {},
    uiExtensions: overrides.uiExtensions ?? [],
    pages: overrides.pages ?? [],
    apiNamespace: overrides.apiNamespace ?? `/modules/${name.replace('mod.', '')}`,
  };
}

export function buildModule(overrides: Partial<ModuleManifest> = {}): LearnShipModule {
  return {
    manifest: buildManifest(overrides),
    onRegister: vi.fn().mockResolvedValue(undefined),
    onEnable: vi.fn().mockResolvedValue(undefined),
    onDisable: vi.fn().mockResolvedValue(undefined),
    onUninstall: vi.fn().mockResolvedValue(undefined),
  };
}
