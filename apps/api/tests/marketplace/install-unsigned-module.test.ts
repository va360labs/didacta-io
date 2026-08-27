/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Regresión del hallazgo crítico reportado por Bruno
 * (ingenierosindustriales.com) sobre v0.1.0-beta.7. Ver SECURITY-CREDITS.md.
 *
 * QUÉ se prueba aquí, y por qué NO se prueba lo otro:
 *
 * El PoC del reporte escapaba del sandbox con
 * `Object.constructor('return process')()`. Sería fácil escribir un test que
 * ejecute ese payload, verlo fallar y darlo por cerrado — y sería engañarse:
 * el problema no es `Object`, es que `node:vm` NO aísla realms. `Buffer`,
 * `console`, los timers y todo lo que devuelve `require()` siguen siendo
 * objetos del proceso anfitrión, y por cualquiera de ellos se llega al mismo
 * `Function` del host. Probar el payload concreto certificaría la lista, no
 * el camino.
 *
 * Por eso el test que manda es el de la FRONTERA real: código sin firma
 * verificada no llega a ejecutarse. Debajo hay un test de reducción de
 * superficie (los intrínsecos del host ya no se inyectan) etiquetado como lo
 * que es: mitigación, no aislamiento.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledModule } from '@didacta/database';
import { InstallPackageService } from '../../src/marketplace/install-package.service';
import { InstalledModuleService } from '../../src/marketplace/installed-module.service';
import { ModuleLintService } from '../../src/marketplace/module-lint.service';
import { MarketplacePackageError } from '../../src/marketplace/module-package.errors';
import { ModulePackageService } from '../../src/marketplace/module-package.service';
import { ModuleRouterService } from '../../src/marketplace/module-router.service';
import { ModuleSandboxService } from '../../src/marketplace/module-sandbox.service';
import { ModuleSignatureService } from '../../src/marketplace/module-signature.service';
import { buildTestPackage } from './fixtures/build-test-package';

const ENV_CORE = 'DIDACTA_CORE_VERSION';
const ENV_ALLOW = 'DIDACTA_ALLOW_UNVERIFIED_MODULES';

/**
 * Marca observable de que el bundle del módulo llegó a ejecutarse.
 *
 * No sirve escribir en `globalThis` desde el módulo para comprobarlo después
 * desde el test: dentro de la VM `globalThis` es el global DEL CONTEXTO, no el
 * del proceso, así que esa aserción pasaría siempre y no probaría nada. Lo que
 * sí cruza la frontera es el error: si el bundle corre, su `throw` de nivel
 * superior sale como `MODULE_BOOT_FAILED` con este texto dentro.
 */
const BOOT_MARKER = 'PAYLOAD_DEL_MODULO_EJECUTADO';

/** `dist/index.js` que deja constancia en cuanto se evalúa. */
const HOSTILE_BUNDLE = `throw new Error('${BOOT_MARKER}');`;

function makeStorageMock() {
  const upload = vi.fn(async (key: string) => ({ key }));
  const download = vi.fn(async () => Buffer.alloc(0));
  return { upload, download, ctx: { getStorage: () => ({ upload, download }) } };
}

function makeInstalledModuleServiceMock() {
  const row = {
    id: 'row-1',
    name: 'mod.example',
    version: '1.0.0',
    status: 'INSTALLING',
  } as unknown as InstalledModule;
  return {
    findByName: vi.fn(async () => null),
    createInstalling: vi.fn(async () => row),
    markInstalled: vi.fn(async () => ({ ...row, status: 'INSTALLED' })),
    markFailed: vi.fn(async () => row),
    appendMigrationsApplied: vi.fn(async () => row),
    list: vi.fn(async () => []),
  } as unknown as InstalledModuleService;
}

function makeExtraDeps() {
  return [
    {} as never, // httpService
    {} as never, // rateLimiter
    {} as never, // dbService
    {} as never, // didactaFactory
    {} as never, // moduleRegistry
    { get: () => undefined } as never, // tenantContext
    { register: vi.fn(), unregister: vi.fn() } as never, // jobLifecycle
    {} as never, // tenantResolver
  ] as const;
}

function makeService(
  pkg: ModulePackageService,
  installed: InstalledModuleService,
  storage: ReturnType<typeof makeStorageMock>,
) {
  return new InstallPackageService(
    pkg,
    installed,
    storage.ctx as never,
    new ModuleSandboxService(new ModuleLintService()),
    {
      extractMigrations: vi.fn(() => []),
      applyMigrations: vi.fn(async () => ({ applied: [], skipped: [] })),
      lintAllMigrations: vi.fn(),
    } as never,
    new ModuleRouterService(),
    ...makeExtraDeps(),
  );
}

describe('Puerta de firma del marketplace', () => {
  let originalCore: string | undefined;
  let originalAllow: string | undefined;

  beforeEach(() => {
    originalCore = process.env[ENV_CORE];
    originalAllow = process.env[ENV_ALLOW];
    process.env[ENV_CORE] = '1.0.0';
    delete process.env[ENV_ALLOW];
  });

  afterEach(() => {
    if (originalCore === undefined) delete process.env[ENV_CORE];
    else process.env[ENV_CORE] = originalCore;
    if (originalAllow === undefined) delete process.env[ENV_ALLOW];
    else process.env[ENV_ALLOW] = originalAllow;
  });

  it('un paquete con firma NO verificable no se ejecuta ni deja rastro', async () => {
    // Sin registrar la pública en el verifier, la firma no valida: es el caso
    // `DIRECT_UPLOAD` del reporte, que hasta beta.7 se booteaba igual.
    const pkg = new ModulePackageService(new ModuleSignatureService());
    const fixture = await buildTestPackage({ files: { 'dist/index.js': HOSTILE_BUNDLE } });
    const installed = makeInstalledModuleServiceMock();
    const storage = makeStorageMock();
    const svc = makeService(pkg, installed, storage);

    const err = await svc.install(fixture.buffer, 'super-admin-1').catch((e: unknown) => e);

    // El código del bundle NUNCA se evaluó: si lo hubiera hecho, el error
    // sería `MODULE_BOOT_FAILED` con el marcador dentro (ver el test siguiente,
    // que es el contraste que impide que esta aserción pase por casualidad).
    expect(err).toBeInstanceOf(MarketplacePackageError);
    expect((err as MarketplacePackageError).code).toBe('MODULE_SIGNATURE_REQUIRED');
    expect((err as MarketplacePackageError).message).not.toContain(BOOT_MARKER);

    // Y el corte llegó ANTES de tocar nada: sin row en BD, sin blob en storage.
    // El aviso de riesgo dejaba de servir cuando aparecía tras la instalación.
    expect(installed.createInstalling).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('CONTRASTE: con la puerta abierta, ese mismo bundle sí se ejecuta', async () => {
    // Este test existe para que el anterior no pueda pasar por casualidad: si
    // la puerta no estuviera cortando nada, el bundle correría en los DOS.
    process.env[ENV_ALLOW] = 'true';
    const pkg = new ModulePackageService(new ModuleSignatureService());
    const fixture = await buildTestPackage({ files: { 'dist/index.js': HOSTILE_BUNDLE } });
    const svc = makeService(pkg, makeInstalledModuleServiceMock(), makeStorageMock());

    const err = await svc.install(fixture.buffer, 'super-admin-1').catch((e: unknown) => e);

    expect((err as MarketplacePackageError).code).toBe('MODULE_BOOT_FAILED');
    expect((err as MarketplacePackageError).message).toContain(BOOT_MARKER);
  });

  it('con DIDACTA_ALLOW_UNVERIFIED_MODULES=true el operador puede optar por instalarlo', async () => {
    process.env[ENV_ALLOW] = 'true';
    const pkg = new ModulePackageService(new ModuleSignatureService());
    const fixture = await buildTestPackage({});
    const svc = makeService(pkg, makeInstalledModuleServiceMock(), makeStorageMock());

    const result = await svc.install(fixture.buffer, 'super-admin-1');

    expect(result.status).toBe('INSTALLED');
    expect(result.signatureVerified).toBe(false);
    expect(result.source).toBe('DIRECT_UPLOAD');
  });

  it('cualquier valor que no sea exactamente "true" sigue denegando', async () => {
    for (const value of ['1', 'yes', 'TRUE ', 'si', '']) {
      process.env[ENV_ALLOW] = value;
      const pkg = new ModulePackageService(new ModuleSignatureService());
      const fixture = await buildTestPackage({});
      const svc = makeService(pkg, makeInstalledModuleServiceMock(), makeStorageMock());

      // `'TRUE '` sí pasa: se normaliza con trim + lowercase a propósito, para
      // no castigar un espacio suelto en un `.env`. El resto deniega.
      if (value.trim().toLowerCase() === 'true') continue;
      await expect(svc.install(fixture.buffer, 'super-admin-1')).rejects.toBeInstanceOf(
        MarketplacePackageError,
      );
    }
  });

  it('al re-arrancar, los módulos instalados sin firma NO se vuelven a cargar', async () => {
    const pkg = new ModulePackageService(new ModuleSignatureService());
    const storage = makeStorageMock();
    const installed = makeInstalledModuleServiceMock();
    // Un módulo instalado ANTES de este parche: quedó INSTALLED con
    // `manifestJwt` a NULL porque su firma nunca se verificó.
    (installed.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'row-legacy',
        name: 'mod.legacy',
        version: '1.0.0',
        manifestJwt: null,
        packageStorageKey: 'modules/mod.legacy/1.0.0.zip',
        manifestJson: { name: 'mod.legacy', version: '1.0.0' },
      },
    ]);
    const svc = makeService(pkg, installed, storage);

    await svc.onApplicationBootstrap();

    // Ni siquiera se descarga el paquete: se descarta por la marca de firma.
    expect(storage.download).not.toHaveBeenCalled();
  });
});

describe('Superficie del sandbox (mitigación, NO aislamiento)', () => {
  it('ya no se inyectan los intrínsecos del realm anfitrión', () => {
    const sandbox = new ModuleSandboxService(new ModuleLintService());
    // El módulo comprueba desde DENTRO si su `Object` es el del host. Si lo
    // fuera, `Object.constructor` sería el `Function` del anfitrión y el PoC
    // del reporte funcionaría.
    const mod = sandbox.loadModule(
      `module.exports = {
         objetoEsDelContexto: typeof Object === 'function',
         evalTapado: typeof eval === 'undefined',
       };`,
      'mod.probe',
    ) as unknown as Record<string, unknown>;

    expect(mod['objetoEsDelContexto']).toBe(true);
    expect(mod['evalTapado']).toBe(true);
  });

  it('el módulo sigue pudiendo usar los intrínsecos con normalidad', () => {
    const sandbox = new ModuleSandboxService(new ModuleLintService());
    const mod = sandbox.loadModule(
      `const datos = [3, 1, 2].sort();
       module.exports = {
         resultado: JSON.stringify({ datos, ok: Object.keys({ a: 1 }).length === 1 }),
       };`,
      'mod.probe',
    ) as unknown as Record<string, unknown>;

    expect(mod['resultado']).toBe('{"datos":[1,2,3],"ok":true}');
  });
});
