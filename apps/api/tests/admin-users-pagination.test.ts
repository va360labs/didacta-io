/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del fix de paginación + externalSource del endpoint
 * `GET /api/v1/admin/users` (alpha.74).
 *
 * Bug previo: el service ignoraba `page` y `offset` y hacía
 * `findMany({ take: 100 })` sin `skip`, por lo que el operador veía
 * "100 alumnos" cuando la BD tenía 2899 (importados de LearnDash).
 * El response tampoco devolvía `total` ni `externalSource`, así que
 * desde la UI era imposible saber el tamaño real ni distinguir
 * users importados vs nativos.
 *
 * Cubrimos:
 *  - Page 2 devuelve items distintos (skip aplicado).
 *  - `total` viene del count y es independiente del `limit`.
 *  - Filtro por `externalSource` se pasa al where de Prisma.
 *  - El item incluye `externalSource` y `externalId`.
 *  - `hasMore` se calcula correctamente.
 */

import { describe, expect, it, vi } from 'vitest';
import { AdminUsersService } from '../src/admin/admin-users.service';

interface SeedUser {
  id: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
  mfaEnabled: boolean;
  emailVerified: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  externalSource: string | null;
  externalId: string | null;
  roles: Array<{ role: { name: string } }>;
}

function seedUsers(count: number, source: string | null = null): SeedUser[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `u-${i}`,
    email: `u${i}@example.com`,
    name: `User ${i}`,
    status: 'ACTIVE' as const,
    mfaEnabled: false,
    emailVerified: true,
    // createdAt descendente: el más reciente primero (orden del endpoint).
    createdAt: new Date(2026, 0, 1, 0, 0, 0, count - i),
    lastLoginAt: null,
    externalSource: source,
    externalId: source ? `ext-${i}` : null,
    roles: [{ role: { name: 'alumno' } }],
  }));
}

function makeService(allUsers: SeedUser[]) {
  const userCount = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    return filterByWhere(allUsers, where).length;
  });
  const userFindMany = vi.fn(
    async (args: {
      where: Record<string, unknown>;
      skip?: number;
      take?: number;
      orderBy?: unknown;
    }) => {
      const filtered = filterByWhere(allUsers, args.where);
      // Orden por createdAt desc (igual al service real).
      filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return filtered.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? filtered.length));
    },
  );

  const prisma = {
    user: { count: userCount, findMany: userFindMany },
  } as never;

  const noopAudit = { record: vi.fn().mockResolvedValue(undefined) } as never;
  const noopReset = { requestAndSendEmail: vi.fn().mockResolvedValue(undefined) } as never;
  const noopLogger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  return {
    service: new AdminUsersService(prisma, noopAudit, noopReset, noopLogger),
    userCount,
    userFindMany,
  };
}

function filterByWhere(users: SeedUser[], where: Record<string, unknown>): SeedUser[] {
  return users.filter((u) => {
    if (where.externalSource !== undefined && u.externalSource !== where.externalSource) {
      return false;
    }
    if (where.status !== undefined && u.status !== where.status) {
      return false;
    }
    return true;
  });
}

describe('AdminUsersService.list — paginación + externalSource (alpha.74)', () => {
  it('devuelve { items, total, page, limit, hasMore } con shape correcto', async () => {
    const { service } = makeService(seedUsers(250));
    const res = await service.list('t1', { page: 1, limit: 100 });

    expect(res.total).toBe(250);
    expect(res.page).toBe(1);
    expect(res.limit).toBe(100);
    expect(res.items).toHaveLength(100);
    expect(res.hasMore).toBe(true);
  });

  it('page=2 devuelve items distintos de page=1 (skip aplicado)', async () => {
    const { service } = makeService(seedUsers(250));
    const p1 = await service.list('t1', { page: 1, limit: 100 });
    const p2 = await service.list('t1', { page: 2, limit: 100 });

    expect(p1.items).toHaveLength(100);
    expect(p2.items).toHaveLength(100);
    const p1Ids = new Set(p1.items.map((u) => u.id));
    const p2Ids = new Set(p2.items.map((u) => u.id));
    // Ningún id de p1 debe aparecer en p2.
    for (const id of p2Ids) {
      expect(p1Ids.has(id)).toBe(false);
    }
  });

  it('última página marca hasMore=false', async () => {
    const { service } = makeService(seedUsers(250));
    const p3 = await service.list('t1', { page: 3, limit: 100 });
    expect(p3.items).toHaveLength(50); // 250 - 200
    expect(p3.hasMore).toBe(false);
  });

  it('total es independiente del limit (count != findMany)', async () => {
    const { service } = makeService(seedUsers(2899));
    const res = await service.list('t1', { page: 1, limit: 100 });

    expect(res.total).toBe(2899);
    expect(res.items).toHaveLength(100);
    expect(res.hasMore).toBe(true);
  });

  it('filtro externalSource pasa al where de Prisma', async () => {
    const learndashUsers = seedUsers(50, 'learndash');
    const nativeUsers = seedUsers(30, null).map((u, i) => ({ ...u, id: `n-${i}` }));
    const { service, userCount, userFindMany } = makeService([...learndashUsers, ...nativeUsers]);

    const res = await service.list('t1', {
      page: 1,
      limit: 100,
      externalSource: 'learndash',
    });

    expect(res.total).toBe(50);
    expect(res.items).toHaveLength(50);
    expect(res.items.every((u) => u.externalSource === 'learndash')).toBe(true);

    // Verificamos que el where realmente incluye externalSource.
    const countWhere = userCount.mock.calls[0]?.[0].where as Record<string, unknown>;
    const findWhere = userFindMany.mock.calls[0]?.[0].where as Record<string, unknown>;
    expect(countWhere.externalSource).toBe('learndash');
    expect(findWhere.externalSource).toBe('learndash');
  });

  it('los items incluyen externalSource y externalId', async () => {
    const { service } = makeService(seedUsers(5, 'learndash'));
    const res = await service.list('t1', { page: 1, limit: 10 });

    const first = res.items[0]!;
    expect(first.externalSource).toBe('learndash');
    expect(first.externalId).toMatch(/^ext-/);
  });

  it('defaults: sin page/limit usa page=1, limit=100', async () => {
    const { service, userFindMany } = makeService(seedUsers(200));
    const res = await service.list('t1', {});

    expect(res.page).toBe(1);
    expect(res.limit).toBe(100);
    const args = userFindMany.mock.calls[0]?.[0] as { skip?: number; take?: number };
    expect(args.skip).toBe(0);
    expect(args.take).toBe(100);
  });

  it('skip se calcula como (page - 1) * limit', async () => {
    const { service, userFindMany } = makeService(seedUsers(500));
    await service.list('t1', { page: 4, limit: 50 });

    const args = userFindMany.mock.calls[0]?.[0] as { skip?: number; take?: number };
    expect(args.skip).toBe(150); // (4 - 1) * 50
    expect(args.take).toBe(50);
  });

  it('tenantId y deletedAt:null siempre en el where (multi-tenant gate)', async () => {
    const { service, userCount } = makeService(seedUsers(10));
    await service.list('t1', { page: 1, limit: 10 });

    const where = userCount.mock.calls[0]?.[0].where as Record<string, unknown>;
    expect(where.tenantId).toBe('t1');
    expect(where.deletedAt).toBeNull();
  });
});
