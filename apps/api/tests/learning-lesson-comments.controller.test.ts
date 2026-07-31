import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LearningController } from '../src/modules/learning.controller';

const TENANT = 'tenant-a';
const STUDENT = { sub: 'user-1', tenantId: TENANT, roles: ['student'] };

const DTO = { courseId: '11111111-1111-4111-8111-111111111111', body: 'Buen apunte' };

/**
 * Regresión: el controller creaba los comentarios con `displayName: null`
 * hardcodeado, así que TODOS salían como "Anónimo" en la cola de moderación
 * y en la lección. El nombre es un snapshot que se escribe al crear, por lo
 * que resolverlo aquí es la única oportunidad.
 */
function makeDeps(dbUser: { name: string | null; email: string | null } | null) {
  const createLessonComment = vi.fn().mockResolvedValue({ id: 'cm-1' });
  const registry = {
    getLearningService: () => ({ createLessonComment }),
  };
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue(dbUser) },
  };
  return { createLessonComment, registry, prisma };
}

describe('LearningController — autoría de comentarios de lección', () => {
  let deps: ReturnType<typeof makeDeps>;
  let controller: LearningController;

  function build(dbUser: { name: string | null; email: string | null } | null) {
    deps = makeDeps(dbUser);
    controller = new LearningController(
      deps.registry as never,
      {} as never, // unlockNotifier: no se usa en estos tests
      deps.prisma as never,
    );
  }

  beforeEach(() => {
    build({ name: 'Marina Alumna', email: 'marina@example.com' });
  });

  it('sin usuario → 401', async () => {
    await expect(controller.createLessonComment(undefined, 'les-1', DTO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('guarda el nombre del User como authorDisplayName (no "Anónimo")', async () => {
    await controller.createLessonComment(STUDENT as never, 'les-1', DTO);

    expect(deps.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: STUDENT.sub },
      select: { name: true, email: true },
    });
    expect(deps.createLessonComment).toHaveBeenCalledWith(
      TENANT,
      { id: STUDENT.sub, displayName: 'Marina Alumna' },
      { lessonId: 'les-1', courseId: DTO.courseId, body: DTO.body },
    );
  });

  it('cae al email cuando el User no tiene nombre', async () => {
    build({ name: null, email: 'marina@example.com' });

    await controller.createLessonComment(STUDENT as never, 'les-1', DTO);

    expect(deps.createLessonComment).toHaveBeenCalledWith(
      TENANT,
      { id: STUDENT.sub, displayName: 'marina@example.com' },
      expect.anything(),
    );
  });

  it('deja displayName null si el User no existe (edge case, no revienta)', async () => {
    build(null);

    await controller.createLessonComment(STUDENT as never, 'les-1', DTO);

    expect(deps.createLessonComment).toHaveBeenCalledWith(
      TENANT,
      { id: STUDENT.sub, displayName: null },
      expect.anything(),
    );
  });
});
