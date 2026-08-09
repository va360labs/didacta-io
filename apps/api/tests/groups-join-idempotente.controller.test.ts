import { describe, expect, it, vi } from 'vitest';
import { GroupsController } from '../src/modules/groups.controller';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Join idempotente de grupos (hallazgo del inventario de docs): el upsert de
 * membresía no distinguía crear de re-unirse y el increment de memberCount
 * corría SIEMPRE — repetir POST /:id/join inflaba el contador sin límite.
 * Ahora solo se incrementa cuando la membresía se crea de verdad.
 */

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'user-1',
    tenantId: 'tenant-A',
    roles: ['alumno'],
    email: 'a@example.com',
    mfaVerified: true,
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makePrisma(opts: { alreadyMember?: boolean; createThrowsP2002?: boolean } = {}) {
  const prisma = {
    modGroup: {
      findFirst: vi.fn(async () => ({ id: 'g1', tenantId: 'tenant-A', deletedAt: null })),
      update: vi.fn(async () => ({})),
    },
    modGroupMember: {
      findUnique: vi.fn(async () =>
        opts.alreadyMember ? { groupId: 'g1', userId: 'user-1' } : null,
      ),
      create: vi.fn(async () => {
        if (opts.createThrowsP2002) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        return { groupId: 'g1', userId: 'user-1' };
      }),
      delete: vi.fn(async () => ({})),
    },
  };
  return prisma;
}

describe('GroupsController · joinGroup idempotente', () => {
  it('primer join crea la membresía e incrementa memberCount', async () => {
    const prisma = makePrisma();
    const c = new GroupsController(prisma as unknown as PrismaService);
    const res = await c.joinGroup(makeUser(), 'g1');
    expect(res).toEqual({ joined: true });
    expect(prisma.modGroupMember.create).toHaveBeenCalledTimes(1);
    expect(prisma.modGroup.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { memberCount: { increment: 1 } },
    });
  });

  it('re-join de un miembro NO re-incrementa memberCount', async () => {
    const prisma = makePrisma({ alreadyMember: true });
    const c = new GroupsController(prisma as unknown as PrismaService);
    const res = await c.joinGroup(makeUser(), 'g1');
    expect(res).toEqual({ joined: true });
    expect(prisma.modGroupMember.create).not.toHaveBeenCalled();
    expect(prisma.modGroup.update).not.toHaveBeenCalled();
  });

  it('carrera (P2002 en create) tampoco incrementa', async () => {
    const prisma = makePrisma({ createThrowsP2002: true });
    const c = new GroupsController(prisma as unknown as PrismaService);
    const res = await c.joinGroup(makeUser(), 'g1');
    expect(res).toEqual({ joined: true });
    expect(prisma.modGroup.update).not.toHaveBeenCalled();
  });
});
