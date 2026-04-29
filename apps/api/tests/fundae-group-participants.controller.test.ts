import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { FundaeGroupParticipantsController } from '../src/modules/fundae-group-participants.controller';
import type { ModuleRegistryService } from '../src/modules/module-registry.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Tests del controller de matriculaciones nominales en grupo bonificable
 * (LMS-82). Verifican guards de rol, aislamiento por tenantId y
 * delegación correcta al service.
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
  const listByGroup = vi.fn(async () => []);
  const enroll = vi.fn(async () => ({ id: 'p1' }));
  const bulkEnrollFromCourse = vi.fn(async () => ({ enrolled: 3, skipped: 0, total: 3 }));
  const update = vi.fn(async () => ({ id: 'p1' }));
  const remove = vi.fn(async () => undefined);
  const service = { listByGroup, enroll, bulkEnrollFromCourse, update, remove };
  return {
    registry: {
      getFundaeGroupParticipantService: () => service,
    } as unknown as ModuleRegistryService,
    spies: service,
  };
}

describe('FundaeGroupParticipantsController · guard admin', () => {
  it('rechaza sin sesión con UnauthorizedException', async () => {
    const { registry } = makeRegistry();
    const c = new FundaeGroupParticipantsController(registry);
    await expect(c.list(undefined, 'g1', {} as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza alumno con UnauthorizedException', async () => {
    const { registry } = makeRegistry();
    const c = new FundaeGroupParticipantsController(registry);
    await expect(c.list(makeUser({ roles: ['alumno'] }), 'g1', {} as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each(['tenant_admin', 'super_admin'] as const)('rol %s pasa el guard', async (role) => {
    const { registry } = makeRegistry();
    const c = new FundaeGroupParticipantsController(registry);
    await expect(c.list(makeUser({ roles: [role] }), 'g1', {} as never)).resolves.toEqual([]);
  });
});

describe('FundaeGroupParticipantsController · aislamiento tenant', () => {
  it('list pasa tenantId del JWT y traduce includeRemoved="true"', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupParticipantsController(registry);
    await c.list(makeUser({ tenantId: 'tenant-X' }), 'g1', {
      includeRemoved: 'true',
    } as never);
    expect(spies.listByGroup).toHaveBeenCalledWith('tenant-X', 'g1', { includeRemoved: true });
  });

  it('list traduce includeRemoved omitido a false', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupParticipantsController(registry);
    await c.list(makeUser({ tenantId: 'tenant-X' }), 'g1', {} as never);
    expect(spies.listByGroup).toHaveBeenCalledWith('tenant-X', 'g1', { includeRemoved: false });
  });

  it('enroll pasa tenantId, actorId, groupId y dto', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupParticipantsController(registry);
    const dto = { userId: '00000000-0000-0000-0000-000000000001' };
    await c.enroll(makeUser({ tenantId: 'tenant-X', sub: 'actor-1' }), 'g1', dto);
    expect(spies.enroll).toHaveBeenCalledWith('tenant-X', 'actor-1', 'g1', dto);
  });

  it('bulkEnroll pasa el sourceCourseId si llega', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupParticipantsController(registry);
    await c.bulkEnroll(makeUser({ tenantId: 'tenant-X', sub: 'actor-1' }), 'g1', {
      sourceCourseId: '00000000-0000-0000-0000-0000000000aa',
    });
    expect(spies.bulkEnrollFromCourse).toHaveBeenCalledWith(
      'tenant-X',
      'actor-1',
      'g1',
      '00000000-0000-0000-0000-0000000000aa',
    );
  });

  it('bulkEnroll sin sourceCourseId pasa undefined', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupParticipantsController(registry);
    await c.bulkEnroll(makeUser({ tenantId: 'tenant-X', sub: 'actor-1' }), 'g1', {});
    expect(spies.bulkEnrollFromCourse).toHaveBeenCalledWith('tenant-X', 'actor-1', 'g1', undefined);
  });

  it('remove devuelve { removed: true } y delega al service', async () => {
    const { registry, spies } = makeRegistry();
    const c = new FundaeGroupParticipantsController(registry);
    const result = await c.remove(makeUser({ tenantId: 'tenant-X', sub: 'actor-1' }), 'g1', 'p1');
    expect(spies.remove).toHaveBeenCalledWith('tenant-X', 'actor-1', 'g1', 'p1');
    expect(result).toEqual({ removed: true });
  });
});
