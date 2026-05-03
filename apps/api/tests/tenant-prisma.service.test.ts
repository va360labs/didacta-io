import { describe, expect, it, vi } from 'vitest';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('TenantPrismaService', () => {
  function createMocks() {
    const mockTx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
      user: { findMany: vi.fn().mockResolvedValue([{ id: '1', name: 'Test' }]) },
    };

    const mockPrisma = {
      $transaction: vi.fn(async (cb) => cb(mockTx)),
    } as unknown as PrismaService;

    const tenantContext = new TenantContextService();

    const service = new TenantPrismaService(mockPrisma, tenantContext);

    return { service, mockPrisma, mockTx, tenantContext };
  }

  describe('withTenant()', () => {
    it('ejecuta SET LOCAL con el tenantId del contexto', async () => {
      const { service, mockTx, tenantContext } = createMocks();

      await tenantContext.run({ tenantId: 'tenant-abc', traceId: 'tr-1' }, async () => {
        await service.withTenant(async (tx) => {
          return tx.user.findMany();
        });
      });

      expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith(
        "SET LOCAL app.current_tenant_id = 'tenant-abc'",
      );
    });

    it('lanza error fuera de contexto de tenant', async () => {
      const { service } = createMocks();

      await expect(
        service.withTenant(async () => 'result'),
      ).rejects.toThrow(/no disponible/);
    });

    it('retorna el resultado del callback', async () => {
      const { service, tenantContext } = createMocks();

      const result = await tenantContext.run({ tenantId: 't-1', traceId: 'tr-1' }, async () => {
        return service.withTenant(async () => 'my-result');
      });

      expect(result).toBe('my-result');
    });
  });

  describe('withTenantId()', () => {
    it('acepta tenantId explícito sin requerir contexto', async () => {
      const { service, mockTx } = createMocks();

      const result = await service.withTenantId('explicit-tenant', async (tx) => {
        return tx.user.findMany();
      });

      expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith(
        "SET LOCAL app.current_tenant_id = 'explicit-tenant'",
      );
      expect(result).toEqual([{ id: '1', name: 'Test' }]);
    });
  });

  describe('global', () => {
    it('expone el PrismaService sin modificar', () => {
      const { service, mockPrisma } = createMocks();
      expect(service.global).toBe(mockPrisma);
    });
  });
});

describe('TenantPrismaService — aislamiento concurrente', () => {
  it('requests concurrentes usan sus propios tenantIds', async () => {
    const executedTenants: string[] = [];

    const mockTx = {
      $executeRawUnsafe: vi.fn((sql: string) => {
        const match = sql.match(/= '([^']+)'/);
        if (match) executedTenants.push(match[1]!);
        return Promise.resolve();
      }),
    };

    const mockPrisma = {
      $transaction: vi.fn(async (cb) => cb(mockTx)),
    } as unknown as PrismaService;

    const tenantContext = new TenantContextService();
    const service = new TenantPrismaService(mockPrisma, tenantContext);

    // Simular 3 requests concurrentes con diferentes tenants
    const requests = ['tenant-A', 'tenant-B', 'tenant-C'].map((tenantId) =>
      tenantContext.run({ tenantId, traceId: `tr-${tenantId}` }, async () => {
        // Pequeño delay aleatorio para simular IO
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        await service.withTenant(async () => 'done');
        return tenantId;
      }),
    );

    const results = await Promise.all(requests);

    expect(results).toEqual(['tenant-A', 'tenant-B', 'tenant-C']);
    expect(executedTenants.sort()).toEqual(['tenant-A', 'tenant-B', 'tenant-C']);
  });
});
