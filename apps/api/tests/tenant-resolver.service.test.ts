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

  /**
   * Un tenant suspendido NO es un host desconocido.
   *
   * Antes las dos cosas eran `null` y la web contestaba «Not Found» en el aula
   * de un cliente con la suscripción vencida. `resolveHostStatus` las separa;
   * `resolveByHost` sigue devolviendo solo tenants ACTIVOS, que es lo que
   * impide iniciar sesión en uno suspendido.
   */
  describe('resolveHostStatus() / resolveByHost()', () => {
    const domainOf = (status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED') => ({
      hostname: 'aula.academia.com',
      surface: 'APP',
      tenant: { id: 'tenant-1', slug: 'academia', name: 'Academia Ejemplo', status },
    });
    const findFirst = (mockPrisma: PrismaService) =>
      mockPrisma.tenantDomain.findFirst as ReturnType<typeof vi.fn>;

    it('tenant ACTIVO → active, con el tenant', async () => {
      const { service, mockPrisma } = createMocks();
      findFirst(mockPrisma).mockResolvedValue(domainOf('ACTIVE'));

      expect(await service.resolveHostStatus('aula.academia.com')).toEqual({
        status: 'active',
        tenant: {
          id: 'tenant-1',
          slug: 'academia',
          name: 'Academia Ejemplo',
          matchedBy: 'hostname',
          hostname: 'aula.academia.com',
          surface: 'APP',
        },
      });
      expect((await service.resolveByHost('aula.academia.com'))?.id).toBe('tenant-1');
    });

    it('tenant SUSPENDIDO → suspended, y NADA más: ni id, ni slug, ni nombre', async () => {
      const { service, mockPrisma } = createMocks();
      findFirst(mockPrisma).mockResolvedValue(domainOf('SUSPENDED'));

      const resolution = await service.resolveHostStatus('aula.academia.com');

      expect(resolution).toEqual({ status: 'suspended' });
      expect(JSON.stringify(resolution)).not.toMatch(/tenant-1|academia|Academia Ejemplo/);
    });

    it('tenant SUSPENDIDO → resolveByHost sigue dando null (no se puede iniciar sesión en él)', async () => {
      const { service, mockPrisma } = createMocks();
      findFirst(mockPrisma).mockResolvedValue(domainOf('SUSPENDED'));

      expect(await service.resolveByHost('aula.academia.com')).toBeNull();
      expect(await service.resolveByRequest({ headers: { host: 'aula.academia.com' } })).toBeNull();
    });

    it('host que no es de nadie → unknown (el 404 de siempre), no suspended', async () => {
      const { service, mockPrisma } = createMocks();
      findFirst(mockPrisma).mockResolvedValue(null);

      expect(await service.resolveHostStatus('zzz-random.didacta.io')).toEqual({
        status: 'unknown',
      });
      expect(await service.resolveByHost('zzz-random.didacta.io')).toBeNull();
    });

    it('tenant ARCHIVADO → unknown: ahí ya no hay nada que reactivar', async () => {
      const { service, mockPrisma } = createMocks();
      findFirst(mockPrisma).mockResolvedValue(domainOf('ARCHIVED'));

      expect(await service.resolveHostStatus('aula.academia.com')).toEqual({ status: 'unknown' });
      expect(await service.resolveByHost('aula.academia.com')).toBeNull();
    });

    it('sin host → unknown, sin consultar la BD', async () => {
      const { service, mockPrisma } = createMocks();

      expect(await service.resolveHostStatus(undefined)).toEqual({ status: 'unknown' });
      expect(await service.resolveHostStatus('   ')).toEqual({ status: 'unknown' });
      expect(findFirst(mockPrisma)).not.toHaveBeenCalled();
    });

    it('solo mira dominios VERIFICADOS, con el host normalizado', async () => {
      // Un dominio sin verificar de un tenant suspendido no puede servir para
      // sondear qué aulas existen: la consulta lo deja fuera antes de mirar el
      // estado.
      const { service, mockPrisma } = createMocks();
      findFirst(mockPrisma).mockResolvedValue(null);

      await service.resolveHostStatus('Aula.Academia.COM:443');

      expect(findFirst(mockPrisma)).toHaveBeenCalledWith({
        where: { hostname: 'aula.academia.com', isVerified: true },
        include: { tenant: true },
      });
    });

    it('resolveHostStatusByRequest pregunta por el host PÚBLICO, no por el del salto interno', async () => {
      const { service, mockPrisma } = createMocks();
      findFirst(mockPrisma).mockResolvedValue(domainOf('SUSPENDED'));

      const resolution = await service.resolveHostStatusByRequest({
        headers: { host: 'localhost:4000', 'x-forwarded-host': 'aula.academia.com' },
      });

      expect(resolution).toEqual({ status: 'suspended' });
      expect(findFirst(mockPrisma)).toHaveBeenCalledWith(
        expect.objectContaining({ where: { hostname: 'aula.academia.com', isVerified: true } }),
      );
    });
  });

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
