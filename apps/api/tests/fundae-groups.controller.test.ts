import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { FundaeGroupsController } from '../src/modules/fundae-groups.controller';
import type { ModuleRegistryService } from '../src/modules/module-registry.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Tests del controller que envuelve FundaeGroupService (LMS-81).
 * Verifican guards de rol, aislamiento por tenantId y delegación
 * correcta al service. La lógica de negocio (RLPT, crédito) está
 * cubierta en `modules/fundae/tests/*`.
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
  const get = vi.fn(async () => ({ id: 'g1', status: 'DRAFT' }));
  const create = vi.fn(async () => ({ id: 'g1' }));
  const update = vi.fn(async () => ({ id: 'g1' }));
  const start = vi.fn(async () => ({ id: 'g1', status: 'ACTIVE' }));
  const close = vi.fn(async () => ({ id: 'g1', status: 'CLOSED' }));
  const cancel = vi.fn(async () => ({ id: 'g1', status: 'CANCELLED' }));
  const listCosts = vi.fn(async () => []);
  const addCost = vi.fn(async () => ({ id: 'c1' }));
  const updateCost = vi.fn(async () => ({ id: 'c1' }));
  const removeCost = vi.fn(async () => undefined);

  const service = {
    list,
    get,
    create,
    update,
    start,
    close,
    cancel,
    listCosts,
    addCost,
    updateCost,
    removeCost,
  };
  return {
    registry: {
      getFundaeGroupService: () => service,
    } as unknown as ModuleRegistryService,
    spies: service,
  };
}

describe('FundaeGroupsController · guard admin', () => {
  it('rechaza sin sesión con UnauthorizedException', async () => {
    const { registry } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    await expect(c.list(undefined, {} as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza alumno con UnauthorizedException', async () => {
    const { registry } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    await expect(c.list(makeUser({ roles: ['alumno'] }), {} as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each(['tenant_admin', 'super_admin'] as const)('rol %s pasa el guard', async (role) => {
    const { registry } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    await expect(c.list(makeUser({ roles: [role] }), {} as never)).resolves.toEqual([]);
  });
});

describe('FundaeGroupsController · aislamiento tenant', () => {
  it('list pasa tenantId del JWT al service', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    await c.list(makeUser({ tenantId: 'tenant-X' }), {} as never);
    expect(spies.list).toHaveBeenCalledWith('tenant-X', expect.any(Object));
  });

  it('get pasa tenantId del JWT', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    await c.get(makeUser({ tenantId: 'tenant-X' }), 'g1');
    expect(spies.get).toHaveBeenCalledWith('tenant-X', 'g1');
  });

  it('start pasa tenantId y actorId del JWT', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    await c.start(makeUser({ tenantId: 'tenant-X', sub: 'actor-1' }), 'g1');
    expect(spies.start).toHaveBeenCalledWith('tenant-X', 'actor-1', 'g1');
  });

  it('close pasa tenantId y actorId del JWT', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    await c.close(makeUser({ tenantId: 'tenant-X', sub: 'actor-1' }), 'g1');
    expect(spies.close).toHaveBeenCalledWith('tenant-X', 'actor-1', 'g1');
  });

  it('cancel pasa tenantId y actorId del JWT', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    await c.cancel(makeUser({ tenantId: 'tenant-X', sub: 'actor-1' }), 'g1');
    expect(spies.cancel).toHaveBeenCalledWith('tenant-X', 'actor-1', 'g1');
  });
});

describe('FundaeGroupsController · costes', () => {
  it('listCosts pasa tenantId y groupId', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    await c.listCosts(makeUser({ tenantId: 'tenant-X' }), 'g1');
    expect(spies.listCosts).toHaveBeenCalledWith('tenant-X', 'g1');
  });

  it('addCost pasa tenantId, actorId, groupId y dto', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    const dto = { tipo: 'DIRECTO' as const, concepto: 'Test', amountCents: 10000 };
    await c.addCost(makeUser({ tenantId: 'tenant-X', sub: 'actor-1' }), 'g1', dto);
    expect(spies.addCost).toHaveBeenCalledWith('tenant-X', 'actor-1', 'g1', dto);
  });

  it('removeCost devuelve { deleted: true } y delega al service', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupsController(registry);
    const result = await c.removeCost(
      makeUser({ tenantId: 'tenant-X', sub: 'actor-1' }),
      'g1',
      'c1',
    );
    expect(spies.removeCost).toHaveBeenCalledWith('tenant-X', 'actor-1', 'g1', 'c1');
    expect(result).toEqual({ deleted: true });
  });
});
