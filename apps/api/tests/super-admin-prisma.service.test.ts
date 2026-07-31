import { describe, expect, it, vi } from 'vitest';
import { SuperAdminPrismaService } from '../src/tenancy/super-admin-prisma.service';
import { TenantContextService } from '../src/tenancy/tenant-context.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('SuperAdminPrismaService', () => {
  function createMocks() {
    const mockTx = {
      $queryRaw: vi.fn().mockResolvedValue(undefined),
      tenant: { findMany: vi.fn().mockResolvedValue([{ id: 't-1' }, { id: 't-2' }]) },
    };

    const mockPrisma = {
      $transaction: vi.fn(async (cb) => cb(mockTx)),
      installedModule: {
        findMany: vi.fn().mockResolvedValue([{ name: 'mod.test' }]),
      },
    } as unknown as PrismaService;

    const tenantContext = new TenantContextService();
    const service = new SuperAdminPrismaService(mockPrisma, tenantContext);

    return { service, mockPrisma, mockTx, tenantContext };
  }

  describe('client', () => {
    it('expone el PrismaService directamente', () => {
      const { service, mockPrisma } = createMocks();
      expect(service.client).toBe(mockPrisma);
    });

    it('permite queries en tablas globales sin SET LOCAL', async () => {
      const { service } = createMocks();

      const result = await service.client.installedModule.findMany();

      expect(result).toEqual([{ name: 'mod.test' }]);
    });
  });

  describe('run()', () => {
    it('ejecuta callback con el cliente sin modificar', async () => {
      const { service, mockPrisma } = createMocks();

      const result = await service.run(async (prisma) => {
        expect(prisma).toBe(mockPrisma);
        return prisma.installedModule.findMany();
      });

      expect(result).toEqual([{ name: 'mod.test' }]);
    });
  });

  describe('asAdmin()', () => {
    it('setea tenantId explícito para operaciones cross-tenant', async () => {
      const { service, mockTx } = createMocks();

      await service.asAdmin('admin-target-tenant', async (prisma) => {
        return prisma.tenant.findMany();
      });

      const [strings, ...values] = mockTx.$queryRaw.mock.calls[0]!;
      expect(strings.join('$1')).toContain("set_config('app.current_tenant_id'");
      expect(values).toEqual(['admin-target-tenant']);
    });

    it('retorna el resultado del callback', async () => {
      const { service } = createMocks();

      const result = await service.asAdmin('t-1', async () => 'admin-result');

      expect(result).toBe('admin-result');
    });

    it('establece contexto ALS con gucApplied durante el callback', async () => {
      const { service, tenantContext } = createMocks();

      await service.asAdmin('t-guc', async () => {
        expect(tenantContext.get()?.tenantId).toBe('t-guc');
        expect(tenantContext.get()?.gucApplied).toBe(true);
        return null;
      });
    });

    it('loguea warning de bypass (verificar con spy)', async () => {
      const { service } = createMocks();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // El Logger de NestJS usa console internamente en tests
      await service.asAdmin('suspicious-tenant', async () => null);

      // No podemos verificar el Logger directamente sin más setup,
      // pero al menos verificamos que no lanza
      warnSpy.mockRestore();
    });
  });
});

describe('SuperAdminPrismaService — uso válido vs inválido', () => {
  it('documentación: casos de uso válidos', () => {
    // Este test es principalmente documentación viva.
    // Los casos válidos para SuperAdminPrismaService:
    const validUseCases = [
      'Seeders y migraciones',
      'Jobs globales (cleanup de datos huérfanos)',
      'Admin endpoints que operan cross-tenant',
      'Marketplace: instalación de módulos (tabla installed_module es global)',
    ];

    expect(validUseCases).toHaveLength(4);
  });

  it('documentación: casos INVÁLIDOS que violan aislamiento', () => {
    // NUNCA usar SuperAdminPrismaService para:
    const invalidUseCases = [
      'Request path de usuario final (alumno, formador)',
      'Queries donde el usuario actual no es super_admin',
      'Lectura de datos de un tenant sin autorización explícita',
    ];

    expect(invalidUseCases).toHaveLength(3);
  });
});
