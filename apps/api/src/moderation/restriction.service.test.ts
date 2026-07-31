import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestrictionService } from './restriction.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ACTOR = '22222222-2222-2222-2222-222222222222';
const TARGET = '33333333-3333-3333-3333-333333333333';

function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'r1',
    tenantId: TENANT,
    userId: TARGET,
    scopes: ['community'],
    reason: 'Spam repetido en el feed',
    expiresAt: null,
    createdById: ACTOR,
    createdAt: new Date('2026-07-30T10:00:00Z'),
    liftedAt: null,
    liftedById: null,
    liftReason: null,
    ...over,
  };
}

function setup(over: { targetRoles?: string[] } = {}) {
  const prisma = {
    userRestriction: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve(makeRow(data))),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve(makeRow(data))),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue({
        id: TARGET,
        roles: (over.targetRoles ?? ['alumno']).map((name) => ({ role: { name } })),
      }),
      findMany: vi.fn().mockResolvedValue([{ id: ACTOR, name: 'Admin', email: 'a@x.com' }]),
    },
  };
  const auditLog = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new RestrictionService(prisma as never, auditLog as never);
  return { service, prisma, auditLog };
}

describe('RestrictionService.create — guardarraíles', () => {
  it('exige al menos un área', async () => {
    const { service } = setup();
    await expect(
      service.create(TENANT, ACTOR, TARGET, { scopes: [], reason: 'motivo' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rechaza áreas desconocidas', async () => {
    const { service } = setup();
    await expect(
      service.create(TENANT, ACTOR, TARGET, { scopes: ['inventada'], reason: 'motivo' }),
    ).rejects.toThrow(/Áreas desconocidas/);
  });

  it('exige motivo', async () => {
    const { service } = setup();
    await expect(
      service.create(TENANT, ACTOR, TARGET, { scopes: ['community'], reason: '   ' }),
    ).rejects.toThrow(/motivo es obligatorio/);
  });

  it('rechaza una fecha de fin en el pasado', async () => {
    const { service } = setup();
    await expect(
      service.create(TENANT, ACTOR, TARGET, {
        scopes: ['community'],
        reason: 'motivo',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/tiene que ser futura/);
  });

  it('rechaza una fecha ilegible', async () => {
    const { service } = setup();
    await expect(
      service.create(TENANT, ACTOR, TARGET, {
        scopes: ['community'],
        reason: 'motivo',
        expiresAt: 'mañana por la tarde',
      }),
    ).rejects.toThrow(/no es válida/);
  });

  it('no deja que un admin se sancione a sí mismo', async () => {
    const { service } = setup();
    await expect(
      service.create(TENANT, ACTOR, ACTOR, { scopes: ['community'], reason: 'motivo' }),
    ).rejects.toThrow(/a ti mismo/);
  });

  it('no deja sancionar a un super_admin', async () => {
    const { service } = setup({ targetRoles: ['super_admin'] });
    await expect(
      service.create(TENANT, ACTOR, TARGET, { scopes: ['community'], reason: 'motivo' }),
    ).rejects.toThrow(/super administrador/);
  });

  it('falla si el usuario no existe en el tenant', async () => {
    const { service, prisma } = setup();
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(
      service.create(TENANT, ACTOR, TARGET, { scopes: ['community'], reason: 'motivo' }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('RestrictionService.create — normalización y auditoría', () => {
  it('el comodín descarta el resto de áreas para cubrir las futuras', async () => {
    const { service, prisma } = setup();
    await service.create(TENANT, ACTOR, TARGET, {
      scopes: ['community', 'all', 'ai'],
      reason: 'Acoso',
    });
    expect(prisma.userRestriction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scopes: ['all'] }) }),
    );
  });

  it('deduplica áreas repetidas', async () => {
    const { service, prisma } = setup();
    await service.create(TENANT, ACTOR, TARGET, {
      scopes: ['community', 'community'],
      reason: 'Spam',
    });
    expect(prisma.userRestriction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scopes: ['community'] }) }),
    );
  });

  it('deja la sanción en el audit log', async () => {
    const { service, auditLog } = setup();
    await service.create(TENANT, ACTOR, TARGET, {
      scopes: ['community'],
      reason: 'Spam repetido',
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actorId: ACTOR,
        action: 'admin.user.restricted',
        resourceType: 'user',
        resourceId: TARGET,
        metadata: expect.objectContaining({ scopes: ['community'], permanent: true }),
      }),
    );
  });

  it('marca permanent=false cuando lleva fecha de fin', async () => {
    const { service, auditLog } = setup();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await service.create(TENANT, ACTOR, TARGET, {
      scopes: ['community'],
      reason: 'Spam',
      expiresAt: future,
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ permanent: false, expiresAt: future }),
      }),
    );
  });
});

describe('RestrictionService.lift', () => {
  it('sella la sanción en vez de borrarla: el histórico es el expediente', async () => {
    const { service, prisma } = setup();
    prisma.userRestriction.findFirst.mockResolvedValue(makeRow());
    await service.lift(TENANT, ACTOR, 'r1', 'Se disculpó');
    const call = prisma.userRestriction.update.mock.calls[0]![0];
    expect(call.data.liftedAt).toBeInstanceOf(Date);
    expect(call.data.liftedById).toBe(ACTOR);
    expect(call.data.liftReason).toBe('Se disculpó');
    expect(prisma.userRestriction.update).toHaveBeenCalledTimes(1);
  });

  it('no deja levantar dos veces la misma', async () => {
    const { service, prisma } = setup();
    prisma.userRestriction.findFirst.mockResolvedValue(makeRow({ liftedAt: new Date() }));
    await expect(service.lift(TENANT, ACTOR, 'r1', null)).rejects.toThrow(/ya estaba levantada/);
  });

  it('falla si la sanción no existe en el tenant', async () => {
    const { service } = setup();
    await expect(service.lift(TENANT, ACTOR, 'nope', null)).rejects.toThrow(NotFoundException);
  });

  it('audita el levantamiento', async () => {
    const { service, prisma, auditLog } = setup();
    prisma.userRestriction.findFirst.mockResolvedValue(makeRow());
    await service.lift(TENANT, ACTOR, 'r1', 'Resuelto');
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.user.restriction_lifted',
        resourceId: TARGET,
      }),
    );
  });
});

describe('RestrictionService.activeRestrictions — caché', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('filtra levantadas y caducadas en la query', async () => {
    const { service, prisma } = setup();
    await service.activeRestrictions(TENANT, TARGET);
    const where = prisma.userRestriction.findMany.mock.calls[0]![0].where;
    expect(where.liftedAt).toBeNull();
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });

  it('no vuelve a consultar dentro de la ventana de caché', async () => {
    const { service, prisma } = setup();
    await service.activeRestrictions(TENANT, TARGET);
    await service.activeRestrictions(TENANT, TARGET);
    await service.activeRestrictions(TENANT, TARGET);
    expect(prisma.userRestriction.findMany).toHaveBeenCalledTimes(1);
  });

  it('vuelve a consultar pasados los 30 s', async () => {
    const { service, prisma } = setup();
    await service.activeRestrictions(TENANT, TARGET);
    vi.advanceTimersByTime(31_000);
    await service.activeRestrictions(TENANT, TARGET);
    expect(prisma.userRestriction.findMany).toHaveBeenCalledTimes(2);
  });

  it('sancionar invalida la caché al instante en esta instancia', async () => {
    const { service, prisma } = setup();
    await service.activeRestrictions(TENANT, TARGET);
    await service.create(TENANT, ACTOR, TARGET, { scopes: ['community'], reason: 'Spam' });
    await service.activeRestrictions(TENANT, TARGET);
    expect(prisma.userRestriction.findMany).toHaveBeenCalledTimes(2);
  });

  it('levantar invalida la caché al instante', async () => {
    const { service, prisma } = setup();
    prisma.userRestriction.findFirst.mockResolvedValue(makeRow());
    await service.activeRestrictions(TENANT, TARGET);
    await service.lift(TENANT, ACTOR, 'r1', null);
    await service.activeRestrictions(TENANT, TARGET);
    expect(prisma.userRestriction.findMany).toHaveBeenCalledTimes(2);
  });

  it('recorta el TTL cuando la sanción vence antes de los 30 s', async () => {
    const { service, prisma } = setup();
    // Vence dentro de 5 s: la caché no puede seguir diciendo que está sancionado
    // durante los 30 s completos.
    prisma.userRestriction.findMany.mockResolvedValue([
      { id: 'r1', scopes: ['community'], reason: 'Spam', expiresAt: new Date(Date.now() + 5_000) },
    ]);
    await service.activeRestrictions(TENANT, TARGET);
    vi.advanceTimersByTime(6_000);
    await service.activeRestrictions(TENANT, TARGET);
    expect(prisma.userRestriction.findMany).toHaveBeenCalledTimes(2);
  });

  it('la caché es por usuario, no global', async () => {
    const { service, prisma } = setup();
    await service.activeRestrictions(TENANT, TARGET);
    await service.activeRestrictions(TENANT, 'otro-usuario');
    expect(prisma.userRestriction.findMany).toHaveBeenCalledTimes(2);
  });

  it('devuelve motivo y vencimiento para que el 403 pueda explicarse', async () => {
    const { service, prisma } = setup();
    const expires = new Date(Date.now() + 86_400_000);
    prisma.userRestriction.findMany.mockResolvedValue([
      { id: 'r1', scopes: ['community'], reason: 'Spam repetido', expiresAt: expires },
    ]);
    const active = await service.activeRestrictions(TENANT, TARGET);
    expect(active).toEqual([
      {
        id: 'r1',
        scopes: ['community'],
        reason: 'Spam repetido',
        expiresAt: expires.toISOString(),
      },
    ]);
  });
});

describe('RestrictionService.list', () => {
  it('marca como inactiva una sanción caducada', async () => {
    const { service, prisma } = setup();
    prisma.userRestriction.findMany.mockResolvedValue([
      makeRow({ expiresAt: new Date(Date.now() - 1000) }),
    ]);
    const [row] = await service.list(TENANT, TARGET);
    expect(row!.active).toBe(false);
  });

  it('marca como inactiva una sanción levantada', async () => {
    const { service, prisma } = setup();
    prisma.userRestriction.findMany.mockResolvedValue([makeRow({ liftedAt: new Date() })]);
    const [row] = await service.list(TENANT, TARGET);
    expect(row!.active).toBe(false);
  });

  it('marca como activa una permanente sin levantar', async () => {
    const { service, prisma } = setup();
    prisma.userRestriction.findMany.mockResolvedValue([makeRow()]);
    const [row] = await service.list(TENANT, TARGET);
    expect(row!.active).toBe(true);
    expect(row!.scopeLabels).toEqual(['Comunidad']);
  });

  it('resuelve el nombre de quien sancionó', async () => {
    const { service, prisma } = setup();
    prisma.userRestriction.findMany.mockResolvedValue([makeRow()]);
    const [row] = await service.list(TENANT, TARGET);
    expect(row!.createdByName).toBe('Admin');
  });
});
