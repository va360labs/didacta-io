import { describe, expect, it } from 'vitest';
import { ModuleRegistry, CoreVersionMismatchError } from '../src/index.js';
import { buildModule, mockContext } from './helpers.js';

const CORE_VERSION = '1.0.0';

function makeRegistry() {
  return new ModuleRegistry({
    coreVersion: CORE_VERSION,
    context: mockContext(),
  });
}

describe('ModuleRegistry', () => {
  it('registra módulos ejecutando onRegister en orden de dependencias', async () => {
    const courses = buildModule({ name: 'mod.courses' });
    const learning = buildModule({
      name: 'mod.learning',
      dependencies: {
        modules: [{ name: 'mod.courses', version: '^1.0.0' }],
        optionalModules: [],
      },
    });
    const registry = makeRegistry();

    await registry.register([learning, courses]);

    expect(courses.onRegister).toHaveBeenCalledOnce();
    expect(learning.onRegister).toHaveBeenCalledOnce();
    expect(registry.listModules()).toHaveLength(2);
    expect(registry.getModule('mod.courses')).toBe(courses);
  });

  it('rechaza registro con coreVersion incompatible', async () => {
    const mod = buildModule({ name: 'mod.futuristic', coreVersionRequired: '^2.0.0' });
    const registry = makeRegistry();
    await expect(registry.register([mod])).rejects.toThrow(CoreVersionMismatchError);
  });

  it('no permite registrar dos veces', async () => {
    const registry = makeRegistry();
    await registry.register([buildModule({ name: 'mod.a' })]);
    await expect(registry.register([buildModule({ name: 'mod.b' })])).rejects.toThrow(
      /ya fue inicializado/,
    );
  });

  it('enableForTenant ejecuta onEnable la primera vez y es idempotente', async () => {
    const mod = buildModule({ name: 'mod.a' });
    const registry = makeRegistry();
    await registry.register([mod]);

    await registry.enableForTenant('tenant-1', 'mod.a');
    await registry.enableForTenant('tenant-1', 'mod.a');

    expect(mod.onEnable).toHaveBeenCalledOnce();
    expect(mod.onEnable).toHaveBeenCalledWith('tenant-1', expect.any(Object));
    expect(registry.getTenantState('tenant-1', 'mod.a')).toBe('enabled');
  });

  it('disableForTenant desactiva solo si está activo', async () => {
    const mod = buildModule({ name: 'mod.a' });
    const registry = makeRegistry();
    await registry.register([mod]);

    await registry.disableForTenant('tenant-1', 'mod.a');
    expect(mod.onDisable).not.toHaveBeenCalled();

    await registry.enableForTenant('tenant-1', 'mod.a');
    await registry.disableForTenant('tenant-1', 'mod.a');
    expect(mod.onDisable).toHaveBeenCalledOnce();
    expect(registry.getTenantState('tenant-1', 'mod.a')).toBe('disabled');
  });

  it('uninstallForTenant ejecuta onUninstall', async () => {
    const mod = buildModule({ name: 'mod.a' });
    const registry = makeRegistry();
    await registry.register([mod]);

    await registry.enableForTenant('tenant-1', 'mod.a');
    await registry.uninstallForTenant('tenant-1', 'mod.a');

    expect(mod.onUninstall).toHaveBeenCalledOnce();
    expect(registry.getTenantState('tenant-1', 'mod.a')).toBe('uninstalled');
  });

  it('operaciones de tenant lanzan si el módulo no está registrado', async () => {
    const registry = makeRegistry();
    await registry.register([]);
    await expect(registry.enableForTenant('tenant-1', 'mod.unknown')).rejects.toThrow(
      /no está registrado/,
    );
  });
});
