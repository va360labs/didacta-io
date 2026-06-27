import { describe, expect, it, vi } from 'vitest';
import type { InstalledModule } from '@didacta/database';
import { InstalledModuleService } from '../../src/marketplace/installed-module.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { baseManifest } from './fixtures/build-test-package';

function makePrismaMock(seed: Partial<InstalledModule>[] = []): {
  prisma: PrismaService;
  store: Map<string, InstalledModule>;
} {
  const store = new Map<string, InstalledModule>();
  for (const item of seed) {
    if (item.name) store.set(item.name, item as InstalledModule);
  }
  const prisma = {
    installedModule: {
      findUnique: vi.fn(
        async ({ where }: { where: { name: string } }) => store.get(where.name) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Partial<InstalledModule> }) => {
        const all = Array.from(store.values());
        return all.filter((row) => {
          if (where.status && row.status !== where.status) return false;
          if (where.vendor && row.vendor !== where.vendor) return false;
          return true;
        });
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = store.get(where.name);
        const next = existing
          ? ({ ...existing, ...update, updatedAt: new Date() } as InstalledModule)
          : ({
              id: `id-${Math.random().toString(36).slice(2, 8)}`,
              ...create,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as InstalledModule);
        store.set(next.name, next);
        return next;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        for (const row of store.values()) {
          if (row.id === where.id) {
            const next = { ...row, ...data, updatedAt: new Date() } as InstalledModule;
            store.set(row.name, next);
            return next;
          }
        }
        throw new Error('not found');
      }),
      delete: vi.fn(async ({ where }: any) => {
        for (const row of store.values()) {
          if (row.id === where.id) {
            store.delete(row.name);
            return row;
          }
        }
        throw new Error('not found');
      }),
    },
  } as unknown as PrismaService;
  return { prisma, store };
}

describe('InstalledModuleService', () => {
  it('createInstalling persiste un row con status=INSTALLING', async () => {
    const { prisma, store } = makePrismaMock();
    const svc = new InstalledModuleService(prisma);
    const row = await svc.createInstalling({
      manifest: baseManifest,
      manifestJwt: 'fake.jwt.token',
      packageStorageKey: 'modules/mod.example/1.0.0-x.zip',
      packageSha256: 'a'.repeat(64),
      packageSizeBytes: 1024,
      installedById: 'user-1',
    });
    expect(row.status).toBe('INSTALLING');
    expect(row.name).toBe('mod.example');
    expect(row.vendor).toBe('DIDACTA');
    expect(store.get('mod.example')?.manifestJwt).toBe('fake.jwt.token');
  });

  it('createInstalling actúa como upsert: reinstall sobreescribe row previo', async () => {
    const { prisma, store } = makePrismaMock([
      {
        id: 'old',
        name: 'mod.example',
        version: '0.9.0',
        status: 'FAILED',
        errorMessage: 'old error',
      } as InstalledModule,
    ]);
    const svc = new InstalledModuleService(prisma);
    await svc.createInstalling({
      manifest: baseManifest,
      manifestJwt: 'fake.jwt.token',
      packageStorageKey: 'modules/mod.example/1.0.0-x.zip',
      packageSha256: 'b'.repeat(64),
      packageSizeBytes: 2048,
      installedById: 'user-2',
    });
    const updated = store.get('mod.example')!;
    expect(updated.status).toBe('INSTALLING');
    expect(updated.errorMessage).toBeNull();
  });

  it('markInstalled actualiza estado y timestamp', async () => {
    const { prisma } = makePrismaMock([
      { id: 'r1', name: 'mod.example', status: 'INSTALLING' } as InstalledModule,
    ]);
    const svc = new InstalledModuleService(prisma);
    const updated = await svc.markInstalled('r1');
    expect(updated.status).toBe('INSTALLED');
    expect(updated.installedAt).toBeInstanceOf(Date);
  });

  it('markFailed trunca el mensaje a 4000 chars', async () => {
    const { prisma } = makePrismaMock([
      { id: 'r1', name: 'mod.example', status: 'INSTALLING' } as InstalledModule,
    ]);
    const svc = new InstalledModuleService(prisma);
    const updated = await svc.markFailed('r1', 'x'.repeat(5000));
    expect(updated.status).toBe('FAILED');
    expect(updated.errorMessage?.length).toBe(4000);
  });

  it('appendMigrationsApplied: array vacío solo actualiza timestamp', async () => {
    const { prisma } = makePrismaMock([
      { id: 'r1', name: 'mod.example', migrationsApplied: [] } as InstalledModule,
    ]);
    const svc = new InstalledModuleService(prisma);
    const updated = await svc.appendMigrationsApplied('r1', []);
    expect(updated.migrationsAppliedAt).toBeInstanceOf(Date);
  });

  it('appendMigrationsApplied: mergea sin duplicados y ordena', async () => {
    const seed = {
      id: 'r1',
      name: 'mod.example',
      migrationsApplied: ['02_b.sql'],
    } as InstalledModule;
    const { prisma } = makePrismaMock([seed]);
    // Necesitamos extender el mock de findUnique para soportar select.
    (prisma.installedModule as any).findUnique = vi.fn(async ({ where }: any) => {
      if (where.id === 'r1') return seed;
      return null;
    });
    const svc = new InstalledModuleService(prisma);
    await svc.appendMigrationsApplied('r1', ['01_a.sql', '03_c.sql', '02_b.sql']);
    const updateCall = (prisma.installedModule as any).update.mock.calls[0][0];
    expect(updateCall.data.migrationsApplied).toEqual(['01_a.sql', '02_b.sql', '03_c.sql']);
  });

  it('list filtra por status y vendor', async () => {
    const { prisma } = makePrismaMock([
      { name: 'a', status: 'INSTALLED', vendor: 'DIDACTA' } as InstalledModule,
      { name: 'b', status: 'FAILED', vendor: 'DIDACTA' } as InstalledModule,
      { name: 'c', status: 'INSTALLED', vendor: 'COMMUNITY' } as InstalledModule,
    ]);
    const svc = new InstalledModuleService(prisma);
    const onlyInstalled = await svc.list({ status: 'INSTALLED' });
    expect(onlyInstalled.map((r) => r.name).sort()).toEqual(['a', 'c']);
    const onlyDidacta = await svc.list({ vendor: 'DIDACTA' });
    expect(onlyDidacta.map((r) => r.name).sort()).toEqual(['a', 'b']);
  });
});
