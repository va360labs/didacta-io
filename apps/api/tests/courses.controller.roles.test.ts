import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CoursesController } from '../src/modules/courses.controller';
import type { ModuleRegistryService } from '../src/modules/module-registry.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Gating de rol en las ESCRITURAS de mod.courses (hallazgo del inventario de
 * docs): antes cualquier Bearer autenticado (un alumno) podía crear, editar,
 * publicar y borrar cursos. Ahora toda escritura exige formador/admin (403).
 * Las lecturas (list, get, categories) siguen abiertas a cualquier sesión.
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

function makeRegistry() {
  const courses = {
    listCourses: vi.fn(async () => []),
    createCourse: vi.fn(async () => ({ id: 'c1' })),
    updateCourse: vi.fn(async () => ({ id: 'c1' })),
    createModule: vi.fn(async () => ({ id: 'm1' })),
    createLesson: vi.fn(async () => ({ id: 'l1' })),
    updateLesson: vi.fn(async () => ({ id: 'l1' })),
    publishCourse: vi.fn(async () => ({ id: 'c1', status: 'PUBLISHED' })),
    archiveCourse: vi.fn(async () => ({ id: 'c1', status: 'ARCHIVED' })),
    unarchiveCourse: vi.fn(async () => ({ id: 'c1', status: 'DRAFT' })),
    moveLesson: vi.fn(async () => ({ moved: true })),
    deleteModule: vi.fn(async () => undefined),
    deleteLesson: vi.fn(async () => undefined),
    moveLessonToModule: vi.fn(async () => undefined),
    reorderLessons: vi.fn(async () => undefined),
    reorderModules: vi.fn(async () => undefined),
  };
  return {
    registry: { getCoursesService: () => courses } as unknown as ModuleRegistryService,
    spies: courses,
  };
}

type WriteCall = [string, (c: CoursesController, u: SessionClaims | undefined) => Promise<unknown>];

const WRITES: WriteCall[] = [
  ['create', (c, u) => c.create(u, { title: 'T', slug: 't' } as never)],
  ['update', (c, u) => c.update(u, 'c1', { title: 'T2' } as never)],
  ['addModule', (c, u) => c.addModule(u, 'c1', { title: 'M' } as never)],
  ['addLesson', (c, u) => c.addLesson(u, 'm1', { title: 'L' } as never)],
  ['updateLesson', (c, u) => c.updateLesson(u, 'l1', { title: 'L2' } as never)],
  ['publish', (c, u) => c.publish(u, 'c1')],
  ['archive', (c, u) => c.archive(u, 'c1')],
  ['unarchive', (c, u) => c.unarchive(u, 'c1')],
  ['moveLesson', (c, u) => c.moveLesson(u, 'l1', { direction: 'up' })],
  ['deleteModule', (c, u) => c.deleteModule(u, 'm1')],
  ['deleteLesson', (c, u) => c.deleteLesson(u, 'l1')],
  [
    'moveLessonToModule',
    (c, u) =>
      c.moveLessonToModule(u, 'l1', { targetModuleId: '4c5a1f70-0000-4000-8000-000000000001' }),
  ],
  [
    'reorderLessons',
    (c, u) => c.reorderLessons(u, 'm1', { lessonIds: ['4c5a1f70-0000-4000-8000-000000000002'] }),
  ],
  [
    'reorderModules',
    (c, u) => c.reorderModules(u, 'c1', { moduleIds: ['4c5a1f70-0000-4000-8000-000000000003'] }),
  ],
];

describe('CoursesController · gating de escrituras', () => {
  it.each(WRITES)('%s: rechaza sin sesión con 401', async (_name, call) => {
    const { registry } = makeRegistry();
    const c = new CoursesController(registry);
    await expect(call(c, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each(WRITES)('%s: rechaza alumno con 403', async (_name, call) => {
    const { registry } = makeRegistry();
    const c = new CoursesController(registry);
    await expect(call(c, makeUser())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['formador', 'tenant_admin', 'super_admin'] as const)(
    'create: rol %s pasa el guard',
    async (role) => {
      const { registry, spies } = makeRegistry();
      const c = new CoursesController(registry);
      await c.create(makeUser({ roles: [role], tenantId: 'tenant-X' }), { title: 'T' } as never);
      expect(spies.createCourse).toHaveBeenCalledWith('tenant-X', 'user-1', { title: 'T' });
    },
  );

  it('publish: formador pasa y delega con tenantId del JWT', async () => {
    const { registry, spies } = makeRegistry();
    const c = new CoursesController(registry);
    await c.publish(makeUser({ roles: ['formador'], tenantId: 'tenant-Y' }), 'c9');
    expect(spies.publishCourse).toHaveBeenCalledWith('tenant-Y', 'user-1', 'c9');
  });

  it('la lectura list sigue abierta a un alumno', async () => {
    const { registry, spies } = makeRegistry();
    const c = new CoursesController(registry);
    await c.list(makeUser(), {} as never);
    expect(spies.listCourses).toHaveBeenCalledWith('tenant-A', {});
  });
});
