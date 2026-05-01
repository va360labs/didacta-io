/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del gate `feat:multi_tenant.real` (11º piloto License SDK · ART-010)
 * aplicado a `AdminTenantsService.create` y al endpoint `getCapacityInfo`.
 *
 * Reglas:
 *  - 0 tenants → siempre se permite (lo cubre el setup wizard al primer arranque).
 *  - 1 tenant en CE sin licencia → 2º intento lanza `CapabilityRequiredError`.
 *  - Con dev bypass o licencia EE válida → se permite cualquier número.
 *  - `getCapacityInfo` reporta el cap correcto (1 en CE, null en EE).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CapabilityRequiredError, LicenseService } from '@didacta/license-sdk';
import { AdminTenantsService } from '../src/admin/admin-tenants.service';

type ServiceCtor = ConstructorParameters<typeof AdminTenantsService>;

interface FakePrisma {
  tenant: { count: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  tenantDomain: { findUnique: ReturnType<typeof vi.fn> };
  role: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  modCoursesCourse: { count: ReturnType<typeof vi.fn>; groupBy: ReturnType<typeof vi.fn> };
}

function makePrisma(tenantCount: number): FakePrisma {
  return {
    tenant: {
      count: vi.fn().mockResolvedValue(tenantCount),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    tenantDomain: { findUnique: vi.fn().mockResolvedValue(null) },
    role: { findUnique: vi.fn().mockResolvedValue({ id: 'role-tenant-admin' }) },
    $transaction: vi.fn(),
    modCoursesCourse: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  };
}

const noopAudit = { record: vi.fn().mockResolvedValue(undefined) } as never;
const noopReset = { requestAndSendEmail: vi.fn().mockResolvedValue(undefined) } as never;
const noopLogger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const dto = {
  slug: 'acme',
  name: 'Acme Corp',
  adminEmail: 'admin@acme.test',
  primaryHostname: 'acme.didacta.test',
};

describe('AdminTenantsService · gate feat:multi_tenant.real (ART-010)', () => {
  let license: LicenseService;

  beforeEach(() => {
    license = new LicenseService();
  });

  describe('community (sin licencia, status=community)', () => {
    beforeEach(async () => {
      await license.load({ key: null });
    });

    it('getCapacityInfo: cap=1, capabilityActive=false, canCreate=true cuando count=0', async () => {
      const prisma = makePrisma(0);
      const svc = new AdminTenantsService(
        ...([prisma, noopAudit, noopReset, license, noopLogger] as unknown as ServiceCtor),
      );
      const info = await svc.getCapacityInfo();
      expect(info).toEqual({
        tenantCount: 0,
        limit: 1,
        capabilityActive: false,
        capability: 'feat:multi_tenant.real',
        canCreate: true,
      });
    });

    it('getCapacityInfo: canCreate=false cuando count=1 sin licencia', async () => {
      const prisma = makePrisma(1);
      const svc = new AdminTenantsService(
        ...([prisma, noopAudit, noopReset, license, noopLogger] as unknown as ServiceCtor),
      );
      const info = await svc.getCapacityInfo();
      expect(info.canCreate).toBe(false);
      expect(info.tenantCount).toBe(1);
      expect(info.limit).toBe(1);
    });

    it('create: rechaza con CapabilityRequiredError cuando ya hay 1 tenant', async () => {
      const prisma = makePrisma(1);
      const svc = new AdminTenantsService(
        ...([prisma, noopAudit, noopReset, license, noopLogger] as unknown as ServiceCtor),
      );

      await expect(svc.create('actor-1', dto, 'http://localhost:3000')).rejects.toThrow(
        CapabilityRequiredError,
      );
      // No tocó la transacción ni los datos del nuevo tenant.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.tenantDomain.findUnique).not.toHaveBeenCalled();
    });

    it('create: permite el primer tenant sin licencia (setup wizard / fresh install)', async () => {
      const prisma = makePrisma(0);
      // Forzamos transacción simple — el detalle del tenant lo simulamos.
      const fakeTenant = { id: 'tenant-1' };
      const fakeAdmin = { id: 'user-1' };
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          tenant: { create: vi.fn().mockResolvedValue(fakeTenant) },
          tenantDomain: { create: vi.fn().mockResolvedValue({}) },
          user: { create: vi.fn().mockResolvedValue(fakeAdmin) },
          userRole: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });
      // getDetail re-consulta tenant — devolvemos un mock plausible.
      prisma.tenant.findUnique.mockResolvedValueOnce(null); // existingSlug check
      const findFirstMock = vi.fn().mockResolvedValue({
        id: fakeTenant.id,
        slug: dto.slug,
        name: dto.name,
        status: 'ACTIVE',
        createdAt: new Date(),
        domains: [
          { hostname: dto.primaryHostname, isPrimary: true, isVerified: true },
        ],
        _count: { users: 1 },
      });
      (prisma.tenant as unknown as { findFirst: typeof findFirstMock }).findFirst = findFirstMock;

      const svc = new AdminTenantsService(
        ...([prisma, noopAudit, noopReset, license, noopLogger] as unknown as ServiceCtor),
      );
      const result = await svc.create('actor-1', dto, 'http://localhost:3000');
      expect(result.id).toBe(fakeTenant.id);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('con dev bypass (capability activa, status=dev)', () => {
    beforeEach(async () => {
      await license.load({ allowDevBypass: true, key: 'dev-key' });
    });

    it('getCapacityInfo: limit=null, canCreate=true sin importar cuántos tenants haya', async () => {
      const prisma = makePrisma(42);
      const svc = new AdminTenantsService(
        ...([prisma, noopAudit, noopReset, license, noopLogger] as unknown as ServiceCtor),
      );
      const info = await svc.getCapacityInfo();
      expect(info).toEqual({
        tenantCount: 42,
        limit: null,
        capabilityActive: true,
        capability: 'feat:multi_tenant.real',
        canCreate: true,
      });
    });

    it('create: NO rechaza con count=5 (ilimitado en EE)', async () => {
      const prisma = makePrisma(5);
      const fakeTenant = { id: 'tenant-x' };
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          tenant: { create: vi.fn().mockResolvedValue(fakeTenant) },
          tenantDomain: { create: vi.fn().mockResolvedValue({}) },
          user: { create: vi.fn().mockResolvedValue({ id: 'user-x' }) },
          userRole: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });
      const findFirstMock = vi.fn().mockResolvedValue({
        id: fakeTenant.id,
        slug: dto.slug,
        name: dto.name,
        status: 'ACTIVE',
        createdAt: new Date(),
        domains: [{ hostname: dto.primaryHostname, isPrimary: true, isVerified: true }],
        _count: { users: 1 },
      });
      (prisma.tenant as unknown as { findFirst: typeof findFirstMock }).findFirst = findFirstMock;

      const svc = new AdminTenantsService(
        ...([prisma, noopAudit, noopReset, license, noopLogger] as unknown as ServiceCtor),
      );
      await expect(svc.create('actor-1', dto, 'http://localhost:3000')).resolves.toBeDefined();
    });
  });
});
