import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledModule } from '@didacta/database';
import { InstalledModuleService } from '../../src/marketplace/installed-module.service';
import {
  buildStorageKey,
  InstallPackageService,
} from '../../src/marketplace/install-package.service';
import { ModuleLintService } from '../../src/marketplace/module-lint.service';
import { MarketplacePackageError } from '../../src/marketplace/module-package.errors';
import { ModulePackageService } from '../../src/marketplace/module-package.service';
import { ModuleRouterService } from '../../src/marketplace/module-router.service';
import { ModuleSandboxService } from '../../src/marketplace/module-sandbox.service';
import { ModuleSignatureService } from '../../src/marketplace/module-signature.service';
import { buildTestPackage } from './fixtures/build-test-package';

const ENV_CORE = 'DIDACTA_CORE_VERSION';

function makeStorageMock(): { upload: ReturnType<typeof vi.fn>; ctx: any } {
  const upload = vi.fn(async (key: string) => ({ key }));
  return {
    upload,
    ctx: {
      getStorage: () => ({ upload }),
    },
  };
}

/// Sandbox real: el `dist/index.js` del fixture es trivial
/// (`module.exports = { onInstall: () => {} };`) — pasa lint y boot sin
/// tocar I/O ni red.
function makeRealSandbox(): ModuleSandboxService {
  return new ModuleSandboxService(new ModuleLintService());
}

/// Migrator no-op: el fixture base no incluye `prisma/migrations/`.
function makeNoopMigrations() {
  return {
    extractMigrations: vi.fn(() => []),
    applyMigrations: vi.fn(async () => ({ applied: [], skipped: [] })),
    lintAllMigrations: vi.fn(),
  } as unknown as import('../../src/marketplace/module-migration.service').ModuleMigrationService;
}

function makeInstalledModuleServiceMock(seed?: InstalledModule | null) {
  let row: InstalledModule | null = seed ?? null;
  return {
    findByName: vi.fn(async () => row),
    createInstalling: vi.fn(async (input: any) => {
      row = {
        id: 'row-1',
        ...input.manifest,
        vendor: input.manifest.vendor.toUpperCase(),
        manifestJwt: input.manifestJwt,
        signedAt: new Date(input.manifest.signedAt),
        packageStorageKey: input.packageStorageKey,
        packageSha256: input.packageSha256,
        packageSizeBytes: input.packageSizeBytes,
        prevVersion: input.prevVersion ?? null,
        coreVersionRequired: input.manifest.coreVersionRequired,
        tablePrefix: input.manifest.tablePrefix,
        apiNamespace: input.manifest.apiNamespace,
        requiredCapabilities: input.manifest.requiredCapabilities,
        requiredEnvVars: input.manifest.requiredEnvVars,
        isolation: input.manifest.isolation,
        status: 'INSTALLING',
        errorMessage: null,
        installedById: input.installedById,
        installedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as InstalledModule;
      return row;
    }),
    markInstalled: vi.fn(async () => {
      if (!row) throw new Error('no row');
      row = { ...row, status: 'INSTALLED', installedAt: new Date() } as InstalledModule;
      return row;
    }),
    markFailed: vi.fn(async (_id: string, msg: string) => {
      if (!row) throw new Error('no row');
      row = { ...row, status: 'FAILED', errorMessage: msg } as InstalledModule;
      return row;
    }),
    appendMigrationsApplied: vi.fn(async () => {
      if (!row) throw new Error('no row');
      row = { ...row, migrationsAppliedAt: new Date() } as InstalledModule;
      return row;
    }),
    list: vi.fn(),
    deleteById: vi.fn(),
  } satisfies Partial<InstalledModuleService> as unknown as InstalledModuleService;
}

/// Helper: construye sandbox + signature service, para que el fixture
/// pueda registrar su pública directamente. Cada test instancia un par
/// distinto para aislamiento.
function makeServices() {
  const sig = new ModuleSignatureService();
  sig.onModuleInit();
  return { sig, pkg: new ModulePackageService(sig) };
}

/// Stubs para los providers añadidos al constructor entre alpha.49 y alpha.53:
/// httpService, rateLimiter, dbService (alpha.49/.51), didactaFactory +
/// moduleRegistry + tenantContext (alpha.52 / DD-003) y jobLifecycle (alpha.53
/// / JR-003). Los fixtures base no activan ninguna de estas capacidades
/// (no http, no requiresDb, no didacta, no jobLifecycle), así que los stubs
/// no se invocan más que en `jobLifecycle.unregister(...)` y los `buildScoped*`
/// que devuelven Blocked* sin tocar el resto. Si algún test futuro habilita
/// alguna capacidad, sustituir el stub correspondiente por un mock real.
function makeExtraDeps() {
  return [
    {} as any, // httpService
    {} as any, // rateLimiter
    {} as any, // dbService
    {} as any, // didactaFactory
    {} as any, // moduleRegistry
    { get: () => undefined } as any, // tenantContext
    { register: vi.fn(), unregister: vi.fn() } as any, // jobLifecycle
  ] as const;
}

describe('InstallPackageService.install', () => {
  let originalCore: string | undefined;
  beforeEach(() => {
    originalCore = process.env[ENV_CORE];
    process.env[ENV_CORE] = '1.0.0';
  });
  afterEach(() => {
    if (originalCore === undefined) delete process.env[ENV_CORE];
    else process.env[ENV_CORE] = originalCore;
  });

  it('flujo feliz: validate → createInstalling → upload → markInstalled', async () => {
    const { sig, pkg } = makeServices();
    const fixture = await buildTestPackage({ signatureService: sig });
    const installed = makeInstalledModuleServiceMock();
    const storage = makeStorageMock();
    const svc = new InstallPackageService(
      pkg,
      installed,
      storage.ctx,
      makeRealSandbox(),
      makeNoopMigrations(),
      new ModuleRouterService(),
      ...makeExtraDeps(),
    );

    const result = await svc.install(fixture.buffer, 'user-1');

    expect(result.status).toBe('INSTALLED');
    expect(result.name).toBe('mod.example');
    expect(installed.createInstalling).toHaveBeenCalledOnce();
    expect(storage.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^modules\/mod\.example\/1\.0\.0-\d+\.zip$/),
      fixture.buffer,
      'application/zip',
    );
    expect(installed.markInstalled).toHaveBeenCalledWith('row-1');
    expect(installed.markFailed).not.toHaveBeenCalled();
  });

  it('si storage upload falla, marca FAILED y propaga error', async () => {
    const { sig, pkg } = makeServices();
    const fixture = await buildTestPackage({ signatureService: sig });
    const installed = makeInstalledModuleServiceMock();
    const storage = makeStorageMock();
    storage.upload.mockRejectedValueOnce(new Error('S3 unreachable'));
    const svc = new InstallPackageService(
      pkg,
      installed,
      storage.ctx,
      makeRealSandbox(),
      makeNoopMigrations(),
      new ModuleRouterService(),
      ...makeExtraDeps(),
    );

    await expect(svc.install(fixture.buffer, 'user-1')).rejects.toThrow(/S3 unreachable/);
    expect(installed.markFailed).toHaveBeenCalledWith('row-1', 'S3 unreachable');
    expect(installed.markInstalled).not.toHaveBeenCalled();
  });

  it('rechaza con ALREADY_INSTALLED si misma versión ya está INSTALLED', async () => {
    const { sig, pkg } = makeServices();
    const fixture = await buildTestPackage({ signatureService: sig });
    const installed = makeInstalledModuleServiceMock({
      id: 'row-existing',
      name: 'mod.example',
      version: '1.0.0',
      status: 'INSTALLED',
    } as InstalledModule);
    const storage = makeStorageMock();
    const svc = new InstallPackageService(
      pkg,
      installed,
      storage.ctx,
      makeRealSandbox(),
      makeNoopMigrations(),
      new ModuleRouterService(),
      ...makeExtraDeps(),
    );

    await expect(svc.install(fixture.buffer, 'user-1')).rejects.toMatchObject({
      code: 'ALREADY_INSTALLED',
    });
    expect(installed.createInstalling).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('permite reinstalar si la versión previa quedó FAILED', async () => {
    const { sig, pkg } = makeServices();
    const fixture = await buildTestPackage({ signatureService: sig });
    const installed = makeInstalledModuleServiceMock({
      id: 'row-old',
      name: 'mod.example',
      version: '1.0.0',
      status: 'FAILED',
    } as InstalledModule);
    const storage = makeStorageMock();
    const svc = new InstallPackageService(
      pkg,
      installed,
      storage.ctx,
      makeRealSandbox(),
      makeNoopMigrations(),
      new ModuleRouterService(),
      ...makeExtraDeps(),
    );
    const result = await svc.install(fixture.buffer, 'user-1');
    expect(result.status).toBe('INSTALLED');
  });

  it('upgrade in-place: setea prevVersion correctamente', async () => {
    const { sig, pkg } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifest: { version: '2.0.0' },
    });
    const installed = makeInstalledModuleServiceMock({
      id: 'row-old',
      name: 'mod.example',
      version: '1.0.0',
      status: 'INSTALLED',
    } as InstalledModule);
    const storage = makeStorageMock();
    const svc = new InstallPackageService(
      pkg,
      installed,
      storage.ctx,
      makeRealSandbox(),
      makeNoopMigrations(),
      new ModuleRouterService(),
      ...makeExtraDeps(),
    );

    await svc.install(fixture.buffer, 'user-1');
    expect(installed.createInstalling).toHaveBeenCalledWith(
      expect.objectContaining({ prevVersion: '1.0.0' }),
    );
  });

  it('error de validación NO crea row (corta antes)', async () => {
    const { sig, pkg } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      manifestJwtOverride: 'no-soy-un-jwt',
    });
    const installed = makeInstalledModuleServiceMock();
    const storage = makeStorageMock();
    const svc = new InstallPackageService(
      pkg,
      installed,
      storage.ctx,
      makeRealSandbox(),
      makeNoopMigrations(),
      new ModuleRouterService(),
      ...makeExtraDeps(),
    );

    await expect(svc.install(fixture.buffer, 'user-1')).rejects.toBeInstanceOf(
      MarketplacePackageError,
    );
    expect(installed.createInstalling).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('si el lint del bundle falla, marca FAILED después del upload', async () => {
    const { sig, pkg } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      files: { 'dist/index.js': "const lodash = require('lodash');\nmodule.exports = {};" },
    });
    const installed = makeInstalledModuleServiceMock();
    const storage = makeStorageMock();
    const svc = new InstallPackageService(
      pkg,
      installed,
      storage.ctx,
      makeRealSandbox(),
      makeNoopMigrations(),
      new ModuleRouterService(),
      ...makeExtraDeps(),
    );

    await expect(svc.install(fixture.buffer, 'user-1')).rejects.toMatchObject({
      code: 'MODULE_LINT_FAILED',
    });
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(installed.markFailed).toHaveBeenCalledOnce();
    expect((installed.markFailed as any).mock.calls[0][1]).toMatch(/lodash/);
  });

  it('si el onInstall del módulo lanza, marca FAILED', async () => {
    const { sig, pkg } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      files: {
        'dist/index.js':
          "module.exports = { onInstall: function () { throw new Error('install boom'); } };",
      },
    });
    const installed = makeInstalledModuleServiceMock();
    const storage = makeStorageMock();
    const svc = new InstallPackageService(
      pkg,
      installed,
      storage.ctx,
      makeRealSandbox(),
      makeNoopMigrations(),
      new ModuleRouterService(),
      ...makeExtraDeps(),
    );

    await expect(svc.install(fixture.buffer, 'user-1')).rejects.toMatchObject({
      code: 'MODULE_BOOT_FAILED',
    });
    expect(installed.markFailed).toHaveBeenCalledOnce();
    expect((installed.markFailed as any).mock.calls[0][1]).toMatch(/install boom/);
  });

  it('registra routes del módulo en el router cuando install termina OK', async () => {
    const { sig, pkg } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      files: {
        'dist/index.js': `module.exports = {
          routes: [
            { method: 'GET', path: '/hello', handler: function () { return { status: 200, body: 'ok' }; } },
          ],
        };`,
      },
    });
    const installed = makeInstalledModuleServiceMock();
    const storage = makeStorageMock();
    const router = new ModuleRouterService();
    const svc = new InstallPackageService(
      pkg,
      installed,
      storage.ctx,
      makeRealSandbox(),
      makeNoopMigrations(),
      router,
      ...makeExtraDeps(),
    );

    await svc.install(fixture.buffer, 'user-1');
    const matched = router.match('GET', '/modules/example/hello');
    expect(matched).not.toBeNull();
  });

  it('upgrade: la nueva versión sin routes desregistra las de la anterior', async () => {
    const { sig, pkg } = makeServices();
    const fixture = await buildTestPackage({
      signatureService: sig,
      files: { 'dist/index.js': 'module.exports = {};' },
    });
    const installed = makeInstalledModuleServiceMock({
      id: 'old',
      name: 'mod.example',
      version: '0.9.0',
      status: 'INSTALLED',
    } as InstalledModule);
    const storage = makeStorageMock();
    const router = new ModuleRouterService();
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/old', handler: async () => ({ status: 200, body: 'old' }) },
    ]);
    const svc = new InstallPackageService(
      pkg,
      installed,
      storage.ctx,
      makeRealSandbox(),
      makeNoopMigrations(),
      router,
      ...makeExtraDeps(),
    );
    await svc.install(fixture.buffer, 'user-1');
    expect(router.match('GET', '/modules/example/old')).toBeNull();
  });
});

describe('buildStorageKey', () => {
  it('formato modules/<name>/<version>-<timestamp>.zip', () => {
    const key = buildStorageKey('mod.example', '1.2.3');
    expect(key).toMatch(/^modules\/mod\.example\/1\.2\.3-\d+\.zip$/);
  });

  it('sanitiza caracteres no permitidos', () => {
    const key = buildStorageKey('mod.weird name', '1.0.0/../etc');
    expect(key).not.toContain(' ');
    expect(key).not.toContain('..');
    expect(key).not.toContain('/etc');
  });
});
