/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del listing cross-tenant `SuperUsersService.list` (follow-up
 * `feat:multi_tenant.real`).
 *
 * Reglas:
 *  - Sin licencia EE → `CapabilityRequiredError` antes de tocar la BD.
 *  - Con dev bypass → devuelve usuarios de TODOS los tenants con su info.
 *  - Filtros (search/status/tenantId) se reflejan en `where`; filtro `role`
 *    se aplica post-fetch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CapabilityRequiredError, LicenseService } from '@didacta/license-sdk';
import { SuperUsersService } from '../src/admin/super/super-users.service';

type ServiceCtor = ConstructorParameters<typeof SuperUsersService>;

interface FakePrisma {
  user: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
}

function makeUser(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: overrides['id'] ?? 'u-1',
    email: overrides['email'] ?? 'a@acme.test',
    name: overrides['name'] ?? 'Alice',
    status: overrides['status'] ?? 'ACTIVE',
    roles: overrides['roles'] ?? [{ role: { name: 'tenant_admin' } }],
    mfaEnabled: overrides['mfaEnabled'] ?? false,
    emailVerified: overrides['emailVerified'] ?? true,
    createdAt: overrides['createdAt'] ?? new Date('2026-01-01T00:00:00Z'),
    lastLoginAt: overrides['lastLoginAt'] ?? null,
    tenantId: overrides['tenantId'] ?? 'tenant-acme',
    tenant: overrides['tenant'] ?? {
      id: 'tenant-acme',
      slug: 'acme',
      name: 'Acme Corp',
    },
  };
}

function makePrisma(users: unknown[]): FakePrisma {
  return {
    user: {
      findMany: vi.fn().mockResolvedValue(users),
      count: vi.fn().mockResolvedValue(users.length),
    },
  };
}

describe('SuperUsersService · listings cross-tenant (follow-up multi_tenant.real)', () => {
  let license: LicenseService;

  beforeEach(() => {
    license = new LicenseService();
  });

  describe('sin licencia (community)', () => {
    beforeEach(async () => {
      await license.load({ key: null });
    });

    it('rechaza con CapabilityRequiredError sin tocar Prisma', async () => {
      const prisma = makePrisma([]);
      const svc = new SuperUsersService(
        ...([prisma, license] as unknown as ServiceCtor),
      );
      await expect(svc.list({})).rejects.toThrow(CapabilityRequiredError);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.user.count).not.toHaveBeenCalled();
    });
  });

  describe('con dev bypass (EE activa)', () => {
    beforeEach(async () => {
      await license.load({ allowDevBypass: true, key: 'dev-key' });
    });

    it('devuelve usuarios de todos los tenants con info de tenant inline', async () => {
      const prisma = makePrisma([
        makeUser({ id: 'u-1', tenantId: 't-1', tenant: { id: 't-1', slug: 'acme', name: 'Acme' } }),
        makeUser({ id: 'u-2', tenantId: 't-2', tenant: { id: 't-2', slug: 'globex', name: 'Globex' } }),
      ]);
      const svc = new SuperUsersService(
        ...([prisma, license] as unknown as ServiceCtor),
      );
      const result = await svc.list({});
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({ id: 'u-1', tenantId: 't-1', tenantSlug: 'acme' });
      expect(result.items[1]).toMatchObject({ id: 'u-2', tenantId: 't-2', tenantSlug: 'globex' });
      expect(result.total).toBe(2);
    });

    it('aplica filtro tenantId al where de Prisma', async () => {
      const prisma = makePrisma([]);
      const svc = new SuperUsersService(
        ...([prisma, license] as unknown as ServiceCtor),
      );
      await svc.list({ tenantId: 't-99' });
      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({ tenantId: 't-99', deletedAt: null });
    });

    it('aplica filtro search a email y name (case-insensitive)', async () => {
      const prisma = makePrisma([]);
      const svc = new SuperUsersService(
        ...([prisma, license] as unknown as ServiceCtor),
      );
      await svc.list({ search: 'alice' });
      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.where.OR).toEqual([
        { email: { contains: 'alice', mode: 'insensitive' } },
        { name: { contains: 'alice', mode: 'insensitive' } },
      ]);
    });

    it('limita entre 1 y 200 (default 50)', async () => {
      const prisma = makePrisma([]);
      const svc = new SuperUsersService(
        ...([prisma, license] as unknown as ServiceCtor),
      );
      await svc.list({});
      expect(prisma.user.findMany.mock.calls[0][0].take).toBe(50);
      await svc.list({ limit: 9999 });
      expect(prisma.user.findMany.mock.calls[1][0].take).toBe(200);
      await svc.list({ limit: 0 });
      expect(prisma.user.findMany.mock.calls[2][0].take).toBe(1);
    });

    it('filtro role se aplica post-fetch', async () => {
      const prisma = makePrisma([
        makeUser({ id: 'u-1', roles: [{ role: { name: 'tenant_admin' } }] }),
        makeUser({ id: 'u-2', roles: [{ role: { name: 'alumno' } }] }),
      ]);
      const svc = new SuperUsersService(
        ...([prisma, license] as unknown as ServiceCtor),
      );
      const result = await svc.list({ role: 'alumno' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('u-2');
      // total refleja el count pre-filtro de rol (limitación documentada).
      expect(result.total).toBe(2);
    });
  });
});
