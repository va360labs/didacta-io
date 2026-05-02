import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledModule } from '@didacta/database';
import { InstalledModuleService } from '../../src/marketplace/installed-module.service';
import {
  buildStorageKey,
  InstallPackageService,
} from '../../src/marketplace/install-package.service';
import { MarketplacePackageError } from '../../src/marketplace/module-package.errors';
import { ModulePackageService } from '../../src/marketplace/module-package.service';
import { ModuleSignatureService } from '../../src/marketplace/module-signature.service';
import { buildTestPackage } from './fixtures/build-test-package';

const ENV_VA360 = 'MARKETPLACE_TRUSTED_VENDOR_KEYS_VA360';
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

function makeInstalledModuleServiceMock(seed?: InstalledModule | null) {
  let row: InstalledModule | null = seed ?? null;
  return {
    findByName: vi.fn(async () => row),
    createInstalling: vi.fn(async (input: any) => {
      row = {
        id: 'row-1',
        ...input.manifest,
        vendor: input.manifest.vendor.toUpperCase(),
        signatureB64: input.signatureB64,
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
    markInstalled: vi.fn(async (id: string) => {
      if (!row) throw new Error('no row');
      row = { ...row, status: 'INSTALLED', installedAt: new Date() } as InstalledModule;
      return row;
    }),
    markFailed: vi.fn(async (id: string, msg: string) => {
      if (!row) throw new Error('no row');
      row = { ...row, status: 'FAILED', errorMessage: msg } as InstalledModule;
      return row;
    }),
    list: vi.fn(),
    deleteById: vi.fn(),
  } satisfies Partial<InstalledModuleService> as unknown as InstalledModuleService;
}

describe('InstallPackageService.install', () => {
  let originalKey: string | undefined;
  let originalCore: string | undefined;
  beforeEach(() => {
    originalKey = process.env[ENV_VA360];
    originalCore = process.env[ENV_CORE];
    process.env[ENV_CORE] = '1.0.0';
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env[ENV_VA360];
    else process.env[ENV_VA360] = originalKey;
    if (originalCore === undefined) delete process.env[ENV_CORE];
    else process.env[ENV_CORE] = originalCore;
  });

  it('flujo feliz: validate → createInstalling → upload → markInstalled', async () => {
    const fixture = buildTestPackage();
    process.env[ENV_VA360] = fixture.publicKeyPem;
    const sig = new ModuleSignatureService();
    sig.onModuleInit();
    const pkg = new ModulePackageService(sig);
    const installed = makeInstalledModuleServiceMock();
    const storage = makeStorageMock();
    const svc = new InstallPackageService(pkg, installed, storage.ctx);

    const result = await svc.install(fixture.buffer, 'user-1');

    expect(result.status).toBe('INSTALLED');
    expect(result.name).toBe('mod.example');
    expect(installed.createInstalling).toHaveBeenCalledOnce();
    expect(storage.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^modules\/mod\.example\/1\.0\.0-\d+\.didactamod$/),
      fixture.buffer,
      'application/zip',
    );
    expect(installed.markInstalled).toHaveBeenCalledWith('row-1');
    expect(installed.markFailed).not.toHaveBeenCalled();
  });

  it('si storage upload falla, marca FAILED y propaga error', async () => {
    const fixture = buildTestPackage();
    process.env[ENV_VA360] = fixture.publicKeyPem;
    const sig = new ModuleSignatureService();
    sig.onModuleInit();
    const pkg = new ModulePackageService(sig);
    const installed = makeInstalledModuleServiceMock();
    const storage = makeStorageMock();
    storage.upload.mockRejectedValueOnce(new Error('S3 unreachable'));
    const svc = new InstallPackageService(pkg, installed, storage.ctx);

    await expect(svc.install(fixture.buffer, 'user-1')).rejects.toThrow(/S3 unreachable/);
    expect(installed.markFailed).toHaveBeenCalledWith('row-1', 'S3 unreachable');
    expect(installed.markInstalled).not.toHaveBeenCalled();
  });

  it('rechaza con ALREADY_INSTALLED si misma versión ya está INSTALLED', async () => {
    const fixture = buildTestPackage();
    process.env[ENV_VA360] = fixture.publicKeyPem;
    const sig = new ModuleSignatureService();
    sig.onModuleInit();
    const pkg = new ModulePackageService(sig);
    const installed = makeInstalledModuleServiceMock({
      id: 'row-existing',
      name: 'mod.example',
      version: '1.0.0',
      status: 'INSTALLED',
    } as InstalledModule);
    const storage = makeStorageMock();
    const svc = new InstallPackageService(pkg, installed, storage.ctx);

    await expect(svc.install(fixture.buffer, 'user-1')).rejects.toMatchObject({
      code: 'ALREADY_INSTALLED',
    });
    expect(installed.createInstalling).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('permite reinstalar si la versión previa quedó FAILED', async () => {
    const fixture = buildTestPackage();
    process.env[ENV_VA360] = fixture.publicKeyPem;
    const sig = new ModuleSignatureService();
    sig.onModuleInit();
    const pkg = new ModulePackageService(sig);
    const installed = makeInstalledModuleServiceMock({
      id: 'row-old',
      name: 'mod.example',
      version: '1.0.0',
      status: 'FAILED',
    } as InstalledModule);
    const storage = makeStorageMock();
    const svc = new InstallPackageService(pkg, installed, storage.ctx);
    const result = await svc.install(fixture.buffer, 'user-1');
    expect(result.status).toBe('INSTALLED');
  });

  it('upgrade in-place: setea prevVersion correctamente', async () => {
    const fixture = buildTestPackage({ manifest: { version: '2.0.0' } });
    process.env[ENV_VA360] = fixture.publicKeyPem;
    const sig = new ModuleSignatureService();
    sig.onModuleInit();
    const pkg = new ModulePackageService(sig);
    const installed = makeInstalledModuleServiceMock({
      id: 'row-old',
      name: 'mod.example',
      version: '1.0.0',
      status: 'INSTALLED',
    } as InstalledModule);
    const storage = makeStorageMock();
    const svc = new InstallPackageService(pkg, installed, storage.ctx);

    await svc.install(fixture.buffer, 'user-1');
    expect(installed.createInstalling).toHaveBeenCalledWith(
      expect.objectContaining({ prevVersion: '1.0.0' }),
    );
  });

  it('error de validación NO crea row (corta antes)', async () => {
    const fixture = buildTestPackage({ tamperSignature: true });
    process.env[ENV_VA360] = fixture.publicKeyPem;
    const sig = new ModuleSignatureService();
    sig.onModuleInit();
    const pkg = new ModulePackageService(sig);
    const installed = makeInstalledModuleServiceMock();
    const storage = makeStorageMock();
    const svc = new InstallPackageService(pkg, installed, storage.ctx);

    await expect(svc.install(fixture.buffer, 'user-1')).rejects.toBeInstanceOf(
      MarketplacePackageError,
    );
    expect(installed.createInstalling).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

describe('buildStorageKey', () => {
  it('formato modules/<name>/<version>-<timestamp>.didactamod', () => {
    const key = buildStorageKey('mod.example', '1.2.3');
    expect(key).toMatch(/^modules\/mod\.example\/1\.2\.3-\d+\.didactamod$/);
  });

  it('sanitiza caracteres no permitidos', () => {
    const key = buildStorageKey('mod.weird name', '1.0.0/../etc');
    expect(key).not.toContain(' ');
    expect(key).not.toContain('..');
    expect(key).not.toContain('/etc');
  });
});
