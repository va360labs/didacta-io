import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { FundaeCompaniesController } from '../src/modules/fundae-companies.controller';
import type { ModuleRegistryService } from '../src/modules/module-registry.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Tests del controller que envuelve FundaeCompanyService (LMS-79).
 * Verifican guards de rol, aislamiento por tenantId y delegación
 * correcta al service. La validación NIF + lógica de negocio están
 * cubiertas en `modules/fundae/tests/*` con coverage exhaustivo.
 */

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'admin-1',
    tenantId: 'tenant-A',
    roles: ['tenant_admin'],
    email: 'admin@example.com',
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeRegistry() {
  const list = vi.fn(async () => []);
  const get = vi.fn(async () => null);
  const create = vi.fn(async (_t: string, _a: string | null, dto: { nif: string }) => ({
    id: 'created-id',
    ...dto,
  }));
  const update = vi.fn(async (_t: string, _a: string | null, id: string) => ({
    id,
    updated: true,
  }));
  const softDelete = vi.fn(async () => ({ deleted: true }));
  const service = { list, get, create, update, softDelete };
  return {
    registry: {
      getFundaeCompanyService: () => service,
    } as unknown as ModuleRegistryService,
    spies: { list, get, create, update, softDelete },
  };
}

describe('FundaeCompaniesController · guard admin', () => {
  it('rechaza sin sesión con UnauthorizedException', async () => {
    const { registry } = makeRegistry();
    const c = new FundaeCompaniesController(registry);
    await expect(c.list(undefined, {} as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza alumno con UnauthorizedException', async () => {
    const { registry } = makeRegistry();
    const c = new FundaeCompaniesController(registry);
    await expect(c.list(makeUser({ roles: ['alumno'] }), {} as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each(['tenant_admin', 'super_admin'] as const)('rol %s pasa el guard', async (role) => {
    const { registry } = makeRegistry();
    const c = new FundaeCompaniesController(registry);
    await expect(c.list(makeUser({ roles: [role] }), {} as never)).resolves.toEqual([]);
  });
});

describe('FundaeCompaniesController · aislamiento tenant', () => {
  it('list invoca service con tenantId del JWT (no del query)', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeCompaniesController(registry);
    await c.list(makeUser({ tenantId: 'tenant-A' }), { search: 'foo' } as never);
    expect(spies.list).toHaveBeenCalledWith('tenant-A', { search: 'foo', includeDeleted: false });
  });

  it('list traduce includeDeleted="true" a boolean', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeCompaniesController(registry);
    await c.list(makeUser({ tenantId: 'tenant-A' }), {
      search: 'x',
      includeDeleted: 'true',
    } as never);
    expect(spies.list).toHaveBeenCalledWith('tenant-A', { search: 'x', includeDeleted: true });
  });

  it('get usa el tenantId del JWT', async () => {
    const { registry, spies } = makeRegistry();
    spies.get.mockResolvedValueOnce({ id: 'c-1', razonSocial: 'X' });
    const c = new FundaeCompaniesController(registry);
    await c.get(makeUser({ tenantId: 'tenant-A' }), 'c-1');
    expect(spies.get).toHaveBeenCalledWith('tenant-A', 'c-1');
  });

  it('create persiste con tenantId + actorId del JWT', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeCompaniesController(registry);
    await c.create(makeUser({ tenantId: 'tenant-A', sub: 'admin-1' }), {
      nif: 'A58818501',
      razonSocial: 'Empresa',
    });
    expect(spies.create).toHaveBeenCalledWith(
      'tenant-A',
      'admin-1',
      expect.objectContaining({ nif: 'A58818501' }),
    );
  });

  it('update delega manteniendo tenantId del JWT y param id', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeCompaniesController(registry);
    await c.update(makeUser({ tenantId: 'tenant-A' }), 'c-1', { razonSocial: 'Editada' });
    expect(spies.update).toHaveBeenCalledWith('tenant-A', 'admin-1', 'c-1', {
      razonSocial: 'Editada',
    });
  });

  it('remove dispara soft-delete y devuelve { deleted: true }', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeCompaniesController(registry);
    const result = await c.remove(makeUser({ tenantId: 'tenant-A' }), 'c-1');
    expect(spies.softDelete).toHaveBeenCalledWith('tenant-A', 'admin-1', 'c-1');
    expect(result).toEqual({ deleted: true });
  });
});
