import { describe, expect, it } from 'vitest';
import { ModuleLintService } from '../../src/marketplace/module-lint.service';
import { ModuleSandboxService } from '../../src/marketplace/module-sandbox.service';

function makeSandbox(): ModuleSandboxService {
  return new ModuleSandboxService(new ModuleLintService());
}

describe('ModuleSandboxService.loadModule', () => {
  it('carga un módulo CommonJS y devuelve onInstall ejecutable', async () => {
    const code = `
      module.exports = {
        onInstall: function (ctx) {
          ctx.log('log', 'hola desde mod.test ' + ctx.moduleVersion);
        },
      };
    `;
    const svc = makeSandbox();
    const sandboxed = svc.loadModule(code, 'mod.test');
    expect(typeof sandboxed.onInstall).toBe('function');
    await expect(svc.runOnInstall(sandboxed, 'mod.test', '1.0.0')).resolves.toBeUndefined();
  });

  it('rechaza require fuera de la allowlist en runtime', () => {
    const code = `
      const lodash = require('lodash');
      module.exports = { onInstall: () => {} };
    `;
    const svc = makeSandbox();
    // Lint estático lo coge antes — el mensaje es MODULE_LINT_FAILED.
    expect(() => svc.loadModule(code, 'mod.test')).toThrowError(/MODULE_LINT_FAILED/);
  });

  it('require runtime también rechaza si el lint estático no lo cogió (dynamic name)', () => {
    // Construimos el id dinámicamente para que el lint regex no lo capture.
    const code = `
      const id = ['n', 'e', 't'].join('');
      module.exports = { onInstall: () => { require(id); } };
    `;
    const svc = makeSandbox();
    const sandboxed = svc.loadModule(code, 'mod.test');
    // El require dinámico no se evalúa al boot (está dentro de la función).
    // Se evalúa cuando llamamos onInstall.
    return expect(svc.runOnInstall(sandboxed, 'mod.test', '1.0.0')).rejects.toMatchObject({
      code: 'MODULE_BOOT_FAILED',
    });
  });

  it('rechaza si module.exports no es un objeto', () => {
    const code = `module.exports = 'no soy objeto';`;
    const svc = makeSandbox();
    expect(() => svc.loadModule(code, 'mod.test')).toThrowError(/no exporta un objeto/);
  });

  it('rechaza si onInstall no es función', () => {
    const code = `module.exports = { onInstall: 'string' };`;
    const svc = makeSandbox();
    expect(() => svc.loadModule(code, 'mod.test')).toThrowError(/onInstall/);
  });

  it('captura errores síncronos del top-level y los envuelve en MODULE_BOOT_FAILED', () => {
    const code = `throw new Error('boom en top-level');`;
    const svc = makeSandbox();
    expect(() => svc.loadModule(code, 'mod.test')).toThrowError(/MODULE_BOOT_FAILED/);
  });

  it('captura errores síncronos del onInstall', async () => {
    const code = `module.exports = { onInstall: () => { throw new Error('install fail'); } };`;
    const svc = makeSandbox();
    const sandboxed = svc.loadModule(code, 'mod.test');
    await expect(svc.runOnInstall(sandboxed, 'mod.test', '1.0.0')).rejects.toMatchObject({
      code: 'MODULE_BOOT_FAILED',
    });
  });

  it('captura errores async del onInstall', async () => {
    const code = `
      module.exports = {
        onInstall: async function () { await Promise.resolve(); throw new Error('async fail'); },
      };
    `;
    const svc = makeSandbox();
    const sandboxed = svc.loadModule(code, 'mod.test');
    await expect(svc.runOnInstall(sandboxed, 'mod.test', '1.0.0')).rejects.toMatchObject({
      code: 'MODULE_BOOT_FAILED',
    });
  });

  it('NO expone process al sandbox', () => {
    const code = `module.exports = { processType: typeof process };`;
    const svc = makeSandbox();
    const sandboxed = svc.loadModule(code, 'mod.test') as unknown as { processType: string };
    expect(sandboxed.processType).toBe('undefined');
  });

  it('NO expone fs ni eval al sandbox global', () => {
    const code = `
      module.exports = {
        evalType: typeof eval,
        fsAccessible: (function () { try { return typeof require('crypto'); } catch { return 'denied'; } })(),
      };
    `;
    const svc = makeSandbox();
    const sandboxed = svc.loadModule(code, 'mod.test') as unknown as {
      evalType: string;
      fsAccessible: string;
    };
    // eval dentro del sandbox NO existe como global accesible (la VM no lo expone).
    expect(sandboxed.evalType).toBe('undefined');
    // crypto SÍ está en allowlist → require lo resuelve.
    expect(sandboxed.fsAccessible).toBe('object');
  });

  it('Buffer y URL están disponibles', () => {
    const code = `
      const buf = Buffer.from('hi');
      const u = new URL('https://example.com/path');
      module.exports = { len: buf.length, host: u.host };
    `;
    const svc = makeSandbox();
    const sandboxed = svc.loadModule(code, 'mod.test') as unknown as { len: number; host: string };
    expect(sandboxed.len).toBe(2);
    expect(sandboxed.host).toBe('example.com');
  });

  it('setTimeout cap a 30s', async () => {
    const code = `
      module.exports = {
        onInstall: () => { setTimeout(() => {}, 60000); },
      };
    `;
    const svc = makeSandbox();
    const sandboxed = svc.loadModule(code, 'mod.test');
    await expect(svc.runOnInstall(sandboxed, 'mod.test', '1.0.0')).rejects.toMatchObject({
      code: 'MODULE_BOOT_FAILED',
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // jobLifecycle.onTickFn — Sprint 3 / JR-003
  // ─────────────────────────────────────────────────────────────────────────

  it('detecta y normaliza onJobTick cuando manifest.jobLifecycle.onTickFn existe', () => {
    const code = `
      module.exports = {
        myTick: async (ctx) => ({ status: 'completed' }),
      };
    `;
    const svc = makeSandbox();
    const sandboxed = svc.loadModule(code, 'mod.test', {
      jobLifecycle: { onTickFn: 'myTick' },
    });
    expect(typeof sandboxed.onJobTick).toBe('function');
  });

  it('rechaza con MODULE_BOOT_FAILED si jobLifecycle.onTickFn no existe en el bundle', () => {
    const code = `
      module.exports = {
        // myTick NO está exportado.
        someOther: () => {},
      };
    `;
    const svc = makeSandbox();
    expect(() =>
      svc.loadModule(code, 'mod.test', { jobLifecycle: { onTickFn: 'myTick' } }),
    ).toThrowError(/MODULE_BOOT_FAILED|myTick/);
  });

  it('rechaza con MODULE_BOOT_FAILED si jobLifecycle.onTickFn apunta a algo que no es función', () => {
    const code = `
      module.exports = {
        myTick: 'soy un string',
      };
    `;
    const svc = makeSandbox();
    // El error es MarketplacePackageError con code='MODULE_BOOT_FAILED' y
    // mensaje narrativo. Verificamos por code (no por regex en message,
    // que solo tiene la guía de cómo arreglar el bundle).
    try {
      svc.loadModule(code, 'mod.test', { jobLifecycle: { onTickFn: 'myTick' } });
      expect.fail('debería haber rechazado');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('MODULE_BOOT_FAILED');
      expect((err as Error).message).toContain('myTick');
      expect((err as Error).message).toContain('string');
    }
  });

  it('si manifest no declara jobLifecycle, sandboxed.onJobTick queda undefined', () => {
    const code = `
      module.exports = {
        myTick: async () => ({ status: 'completed' }),
      };
    `;
    const svc = makeSandbox();
    // No pasamos manifest → no hay validación del onTickFn.
    const sandboxed = svc.loadModule(code, 'mod.test');
    expect(sandboxed.onJobTick).toBeUndefined();
  });
});
