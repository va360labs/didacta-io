import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { LearningController } from '../src/modules/learning.controller';
import type { LessonUnlockNotifierWorker } from '../src/modules/lesson-unlock-notifier.worker';
import type { ModuleRegistryService } from '../src/modules/module-registry.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Gating de rol en las invitaciones de mod.learning (hallazgo del inventario
 * de docs): las invitaciones son la llave de matrícula de un curso. Antes
 * cualquier alumno podía listar los códigos vigentes (y matricularse gratis),
 * crear invitaciones o revocar las del staff. Ahora exigen formador/admin.
 */

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'user-1',
    tenantId: 'tenant-A',
    roles: ['alumno'],
    email: 'a@example.com',
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeController() {
  const learning = {
    listInvitationsForCourse: vi.fn(async () => []),
    createInvitation: vi.fn(async () => ({ id: 'inv-1', code: 'ABC' })),
    revokeInvitation: vi.fn(async () => undefined),
  };
  const registry = { getLearningService: () => learning } as unknown as ModuleRegistryService;
  const controller = new LearningController(
    registry,
    {} as LessonUnlockNotifierWorker,
    {} as PrismaService,
  );
  return { controller, spies: learning };
}

describe('LearningController · invitaciones gateadas por rol', () => {
  const CALLS: Array<
    [string, (c: LearningController, u: SessionClaims | undefined) => Promise<unknown>]
  > = [
    ['listInvitations', (c, u) => c.listInvitations(u, { courseId: 'c1' } as never)],
    ['createInvitation', (c, u) => c.createInvitation(u, { courseId: 'c1' } as never)],
    ['revokeInvitation', (c, u) => c.revokeInvitation(u, 'inv-1')],
  ];

  it.each(CALLS)('%s: rechaza sin sesión con 401', async (_name, call) => {
    const { controller } = makeController();
    await expect(call(controller, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each(CALLS)('%s: rechaza alumno con 403', async (_name, call) => {
    const { controller } = makeController();
    await expect(call(controller, makeUser())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['formador', 'tenant_admin', 'super_admin'] as const)(
    'createInvitation: rol %s pasa y delega con tenantId del JWT',
    async (role) => {
      const { controller, spies } = makeController();
      await controller.createInvitation(makeUser({ roles: [role], tenantId: 'tenant-X' }), {
        courseId: 'c1',
      } as never);
      expect(spies.createInvitation).toHaveBeenCalledWith('tenant-X', 'user-1', {
        courseId: 'c1',
      });
    },
  );

  it('revokeInvitation: formador pasa y delega', async () => {
    const { controller, spies } = makeController();
    await controller.revokeInvitation(makeUser({ roles: ['formador'] }), 'inv-9');
    expect(spies.revokeInvitation).toHaveBeenCalledWith('tenant-A', 'inv-9');
  });
});
