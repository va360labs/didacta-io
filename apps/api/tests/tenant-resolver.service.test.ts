import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantResolverService } from '../src/tenancy/tenant-resolver.service';
import type { PrismaService } from '../src/prisma/prisma.service';

describe('TenantResolverService', () => {
  function createMocks() {
    const mockPrisma = {
      tenantDomain: { findFirst: vi.fn() },
      tenant: { findUnique: vi.fn() },
    } as unknown as PrismaService;
    const service = new TenantResolverService(mockPrisma);
    return { service, mockPrisma };
  }

  describe('resolvePrimaryDomain()', () => {
    it('devuelve el hostname del dominio primario verificado', async () => {
      const { service, mockPrisma } = createMocks();
      (mockPrisma.tenantDomain.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        hostname: 'aula.academia.com',
      });

      const result = await service.resolvePrimaryDomain('tenant-1');

      expect(result).toBe('aula.academia.com');
      expect(mockPrisma.tenantDomain.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', isPrimary: true, isVerified: true },
      });
    });

    it('devuelve null si el tenant no tiene dominio primario verificado', async () => {
      const { service, mockPrisma } = createMocks();
      (mockPrisma.tenantDomain.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      expect(await service.resolvePrimaryDomain('tenant-sin-dominio')).toBeNull();
    });
  });

  describe('resolveTenantWebBaseUrl()', () => {
    const ORIGINAL = process.env.WEB_PUBLIC_URL;
    beforeEach(() => delete process.env.WEB_PUBLIC_URL);
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.WEB_PUBLIC_URL;
      else process.env.WEB_PUBLIC_URL = ORIGINAL;
    });

    it('usa el dominio primario del tenant cuando existe', async () => {
      const { service, mockPrisma } = createMocks();
      (mockPrisma.tenantDomain.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        hostname: 'aula.academia.com',
      });

      const result = await service.resolveTenantWebBaseUrl('tenant-1');

      expect(result).toBe('https://aula.academia.com');
    });

    it('tenantId null NO consulta la BD y cae al fallback de siempre', async () => {
      const { service, mockPrisma } = createMocks();

      const result = await service.resolveTenantWebBaseUrl(null);

      expect(mockPrisma.tenantDomain.findFirst).not.toHaveBeenCalled();
      expect(result).toBe('http://localhost:3000');
    });

    it('sin dominio primario, deriva del request como siempre', async () => {
      const { service, mockPrisma } = createMocks();
      (mockPrisma.tenantDomain.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.resolveTenantWebBaseUrl('tenant-1', {
        headers: { host: 'mi-tenant.didacta.io' },
        protocol: 'http',
      });

      expect(result).toBe('http://mi-tenant.didacta.io');
    });
  });

  describe('resolveTenantWebBaseUrlForAuthRedirect()', () => {
    const ORIGINAL = process.env.WEB_PUBLIC_URL;
    beforeEach(() => delete process.env.WEB_PUBLIC_URL);
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.WEB_PUBLIC_URL;
      else process.env.WEB_PUBLIC_URL = ORIGINAL;
    });

    it('usa el dominio primario del tenant SIN pasar por la allowlist', async () => {
      const { service, mockPrisma } = createMocks();
      (mockPrisma.tenantDomain.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        hostname: 'aula.academia.com',
      });

      const result = await service.resolveTenantWebBaseUrlForAuthRedirect('tenant-1', {
        headers: { 'x-forwarded-host': 'atacante.evil' },
      });

      expect(result).toBe('https://aula.academia.com');
    });
  });
});
