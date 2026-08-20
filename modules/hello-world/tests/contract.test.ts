import type { ModuleContext } from '@didacta/core-kernel';
import { ModuleRegistry } from '@didacta/core-registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { helloWorldModule, manifest, HelloWorldService } from '../src/index.js';

function mockContext(): ModuleContext {
  return {
    eventBus: { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as never,
    hookRegistry: { register: vi.fn(), run: vi.fn() } as never,
    storage: {} as never,
    auditLog: { record: vi.fn() } as never,
    evidenceVault: { store: vi.fn() } as never,
    notificationHub: { send: vi.fn() } as never,
    i18n: {
      t: (key: string, vars?: Record<string, unknown>) => `${key}:${vars?.['name']}`,
    } as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    } as never,
    config: { get: vi.fn(), set: vi.fn() } as never,
  };
}

/**
 * La versión de core con la que se monta el registry en estos tests sale del
 * PROPIO manifiesto del módulo, no de un literal. Estaba escrita a mano
 * (`'0.0.1'`) y se quedó desfasada en cuanto el core pasó a validar contra la
 * versión real del producto: dos tests en rojo que no tenían nada que ver con
 * lo que dicen probar. Derivándola, el día que el manifiesto suba a `^0.2.0`
 * esto sigue valiendo solo.
 */
const CORE_VERSION_DEL_MANIFIESTO = manifest.coreVersionRequired.replace(/^[\^~]/, '');

describe('hello-world: contrato de módulo', () => {
  let ctx: ModuleContext;

  beforeEach(() => {
    ctx = mockContext();
  });

  it('el manifest es válido según el schema del core', () => {
    expect(manifest.name).toBe('mod.hello-world');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.tablePrefix).toBe('mod_hello_world_');
    expect(manifest.apiNamespace).toBe('/modules/hello-world');
  });

  it('se registra correctamente en un ModuleRegistry', async () => {
    const registry = new ModuleRegistry({ coreVersion: CORE_VERSION_DEL_MANIFIESTO, context: ctx });
    await registry.register([helloWorldModule]);

    expect(registry.getModule('mod.hello-world')).toBe(helloWorldModule);
    expect(ctx.logger.info).toHaveBeenCalledWith('hello-world: onRegister', {
      name: 'mod.hello-world',
    });
  });

  it('activa y desactiva en un tenant respetando idempotencia', async () => {
    const registry = new ModuleRegistry({ coreVersion: CORE_VERSION_DEL_MANIFIESTO, context: ctx });
    await registry.register([helloWorldModule]);

    await registry.enableForTenant('tenant-1', 'mod.hello-world');
    await registry.enableForTenant('tenant-1', 'mod.hello-world');
    await registry.disableForTenant('tenant-1', 'mod.hello-world');

    expect(registry.getTenantState('tenant-1', 'mod.hello-world')).toBe('disabled');
    expect(ctx.logger.info).toHaveBeenCalledWith('hello-world: onEnable', { tenantId: 'tenant-1' });
    expect(ctx.logger.info).toHaveBeenCalledWith('hello-world: onDisable', {
      tenantId: 'tenant-1',
    });
  });

  it('HelloWorldService.greet emite evento con metadata completa', async () => {
    const service = new HelloWorldService(ctx);
    const result = await service.greet('tenant-1', 'María');

    expect(result).toBe('hello-world.greeting:María');
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'hello-world.greeting.requested',
        version: 1,
        data: { name: 'María' },
        metadata: expect.objectContaining({
          tenantId: 'tenant-1',
          idempotencyKey: 'hello-tenant-1-María',
        }),
      }),
    );
  });
});
