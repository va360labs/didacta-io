import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { InstalledModule } from '@didacta/database';
import { AdminMarketplaceController } from '../../src/marketplace/admin-marketplace.controller';
import type { InstalledModuleService } from '../../src/marketplace/installed-module.service';
import type { InstallPackageService } from '../../src/marketplace/install-package.service';
import { MarketplacePackageError } from '../../src/marketplace/module-package.errors';
import { ModuleRouterService } from '../../src/marketplace/module-router.service';
import type { SessionClaims } from '../../src/auth/token.service';

function userWith(roles: string[]): SessionClaims {
  return {
    sub: 'u-1',
    tenantId: 't-1',
    roles,
    mfaVerified: true,
  } as SessionClaims;
}

function makeController(opts: {
  install?: Partial<InstallPackageService>;
  installed?: Partial<InstalledModuleService>;
  router?: ModuleRouterService;
}): AdminMarketplaceController {
  const install = (opts.install ?? {}) as InstallPackageService;
  const installed = (opts.installed ?? {}) as InstalledModuleService;
  const router = opts.router ?? new ModuleRouterService();
  return new AdminMarketplaceController(install, installed, router);
}

describe('AdminMarketplaceController.installPackage', () => {
  it('401 sin sesión', async () => {
    const ctrl = makeController({});
    await expect(ctrl.installPackage(undefined, Buffer.from('zip'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('403 si el rol no es super_admin', async () => {
    const ctrl = makeController({});
    await expect(
      ctrl.installPackage(userWith(['tenant_admin']), Buffer.from('zip')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('PACKAGE_INVALID_ZIP si el body está vacío', async () => {
    const ctrl = makeController({});
    await expect(
      ctrl.installPackage(userWith(['super_admin']), Buffer.alloc(0)),
    ).rejects.toMatchObject({ code: 'PACKAGE_INVALID_ZIP' });
  });

  it('delega al InstallPackageService con userId del super_admin', async () => {
    const installCalls: Array<{ buffer: Buffer; userId: string }> = [];
    const install = {
      install: vi.fn(async (buffer: Buffer, userId: string) => {
        installCalls.push({ buffer, userId });
        return { id: 'r1', name: 'mod.example', status: 'INSTALLED' } as never;
      }),
    };
    const ctrl = makeController({ install });
    await ctrl.installPackage(userWith(['super_admin']), Buffer.from('payload'));
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0].userId).toBe('u-1');
    expect(installCalls[0].buffer.toString()).toBe('payload');
  });
});

describe('AdminMarketplaceController.list', () => {
  it('exige super_admin', async () => {
    const ctrl = makeController({});
    await expect(ctrl.list(userWith(['tenant_admin']))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechaza filtros con valores inválidos', async () => {
    const installed = { list: vi.fn(async () => []) };
    const ctrl = makeController({ installed });
    await expect(ctrl.list(userWith(['super_admin']), 'banana')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(ctrl.list(userWith(['super_admin']), undefined, 'apple')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(installed.list).not.toHaveBeenCalled();
  });

  it('mapea filtros uppercase y devuelve rows serializados', async () => {
    const row = sampleRow();
    const installed = {
      list: vi.fn(async () => [row]),
    };
    const ctrl = makeController({ installed });
    const out = await ctrl.list(userWith(['super_admin']), 'installed', 'didacta');
    expect(installed.list).toHaveBeenCalledWith({ status: 'INSTALLED', vendor: 'DIDACTA' });
    expect(out.modules).toHaveLength(1);
    expect(out.modules[0].name).toBe('mod.example');
    expect(out.modules[0]).not.toHaveProperty('manifestJson'); // no exponemos el JSON crudo
  });
});

describe('AdminMarketplaceController.findOne / uninstall', () => {
  it('findOne devuelve 404 NOT_FOUND si no existe', async () => {
    const installed = { findByName: vi.fn(async () => null) };
    const ctrl = makeController({ installed });
    await expect(
      ctrl.findOne(userWith(['super_admin']), 'mod.ghost'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('uninstall borra el row si existe', async () => {
    const row = sampleRow();
    const installed = {
      findByName: vi.fn(async () => row),
      deleteById: vi.fn(async () => undefined),
    };
    const ctrl = makeController({ installed });
    await ctrl.uninstall(userWith(['super_admin']), 'mod.example');
    expect(installed.deleteById).toHaveBeenCalledWith(row.id);
  });

  it('uninstall lanza NOT_FOUND si no existe', async () => {
    const installed = { findByName: vi.fn(async () => null), deleteById: vi.fn() };
    const ctrl = makeController({ installed });
    await expect(
      ctrl.uninstall(userWith(['super_admin']), 'mod.ghost'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(installed.deleteById).not.toHaveBeenCalled();
  });

  it('uninstall desregistra las routes del router', async () => {
    const row = sampleRow();
    const installed = {
      findByName: vi.fn(async () => row),
      deleteById: vi.fn(async () => undefined),
    };
    const router = new ModuleRouterService();
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/x', handler: async () => ({ status: 200, body: 'ok' }) },
    ]);
    const ctrl = makeController({ installed, router });
    await ctrl.uninstall(userWith(['super_admin']), 'mod.example');
    expect(router.match('GET', '/modules/example/x')).toBeNull();
  });

  it('listRoutes devuelve los routes registrados del módulo', async () => {
    const row = sampleRow();
    const installed = { findByName: vi.fn(async () => row) };
    const router = new ModuleRouterService();
    router.registerModule('mod.example', '/modules/example', [
      { method: 'GET', path: '/x', handler: async () => ({ status: 200, body: 'ok' }) },
      { method: 'POST', path: '/y', handler: async () => ({ status: 200, body: 'ok' }) },
    ]);
    const ctrl = makeController({ installed, router });
    const out = await ctrl.listRoutes(userWith(['super_admin']), 'mod.example');
    expect(out.routes).toHaveLength(2);
  });
});

function sampleRow(): InstalledModule {
  return {
    id: 'r-1',
    name: 'mod.example',
    version: '1.0.0',
    prevVersion: null,
    vendor: 'DIDACTA',
    displayName: 'Example',
    description: null,
    manifestJson: {},
    manifestJwt: 'fake.jwt.token',
    signedAt: new Date('2026-05-01T00:00:00Z'),
    packageStorageKey: 'modules/mod.example/1.0.0-1.didactamod',
    packageSha256: 'a'.repeat(64),
    packageSizeBytes: 1024,
    coreVersionRequired: '^1.0.0',
    tablePrefix: 'mod_example_',
    apiNamespace: '/modules/example',
    requiredCapabilities: [],
    requiredEnvVars: [],
    isolation: 'vm',
    status: 'INSTALLED',
    errorMessage: null,
    installedById: 'u-1',
    installedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as InstalledModule;
}
