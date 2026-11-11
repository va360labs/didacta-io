import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { SessionClaims } from '../src/auth/token.service';
import { CoursesController } from '../src/modules/courses.controller';
import {
  COURSE_EDITOR_ROLES,
  isCourseEditor,
  lessonContentAllowed,
  resolveLessonContentGate,
} from '../src/modules/lesson-content-gate';
import type { ModuleRegistryService } from '../src/modules/module-registry.service';

/**
 * La regla «¿recibe este alumno el contenido de la lección?» es UNA y la
 * comparten el detalle del curso (que enmascara `content`) y la protección de
 * vídeo (que firma o no la URL). Estos tests fijan la regla y, sobre todo, que
 * el detalle del curso sigue enmascarando exactamente lo mismo que antes de
 * extraerla.
 */

const TENANT = 'tenant-A';
const USER = 'user-1';
const COURSE = 'course-1';

function makeLearning(opts: {
  enrolled: boolean;
  availability?: { drip: boolean; lessons: Record<string, { available: boolean }> };
}) {
  return {
    hasActiveEnrollment: vi.fn(async () => opts.enrolled),
    getCourseAvailability: vi.fn(async () => opts.availability ?? { drip: false, lessons: {} }),
  };
}

describe('resolveLessonContentGate', () => {
  it('sin matrícula viva: ninguna lección, y ni se mira el drip', async () => {
    const learning = makeLearning({ enrolled: false });
    const gate = await resolveLessonContentGate(learning, TENANT, USER, COURSE);
    expect(gate.kind).toBe('none');
    expect(lessonContentAllowed(gate, 'l1')).toBe(false);
    expect(learning.getCourseAvailability).not.toHaveBeenCalled();
    expect(learning.hasActiveEnrollment).toHaveBeenCalledWith(TENANT, USER, COURSE);
  });

  it('matriculado y sin gating: todas', async () => {
    const gate = await resolveLessonContentGate(
      makeLearning({ enrolled: true }),
      TENANT,
      USER,
      COURSE,
    );
    expect(gate.kind).toBe('all');
    expect(lessonContentAllowed(gate, 'cualquiera')).toBe(true);
  });

  it('matriculado con gating: solo las liberadas; las que no aparecen están disponibles', async () => {
    const gate = await resolveLessonContentGate(
      makeLearning({
        enrolled: true,
        availability: {
          drip: true,
          lessons: { bloqueada: { available: false }, liberada: { available: true } },
        },
      }),
      TENANT,
      USER,
      COURSE,
    );
    expect(gate.kind).toBe('some');
    expect(lessonContentAllowed(gate, 'bloqueada')).toBe(false);
    expect(lessonContentAllowed(gate, 'liberada')).toBe(true);
    expect(lessonContentAllowed(gate, 'sin-regla')).toBe(true);
  });

  it('los roles que gestionan cursos', () => {
    expect([...COURSE_EDITOR_ROLES].sort()).toEqual(['formador', 'super_admin', 'tenant_admin']);
    expect(isCourseEditor(['alumno', 'formador'])).toBe(true);
    expect(isCourseEditor(['alumno'])).toBe(false);
    expect(isCourseEditor([])).toBe(false);
  });
});

// ─────────── el detalle del curso enmascara con esa misma regla ───────────

const VIDEO = { videoUrl: 'https://iframe.mediadelivery.net/embed/100200/0f1e2d3c' };

function makeCourse(status = 'PUBLISHED') {
  return {
    id: COURSE,
    status,
    title: 'Curso',
    modules: [
      {
        id: 'm1',
        title: 'Módulo 1',
        lessons: [
          { id: 'l1', title: 'Lección 1', type: 'VIDEO', content: VIDEO },
          { id: 'l2', title: 'Lección 2', type: 'VIDEO', content: VIDEO },
        ],
      },
    ],
  };
}

function makeController(
  course: ReturnType<typeof makeCourse>,
  learning: ReturnType<typeof makeLearning>,
) {
  const registry = {
    getCoursesService: () => ({ getCourseDetail: vi.fn(async () => course) }),
    getLearningService: () => learning,
  } as unknown as ModuleRegistryService;
  return new CoursesController(registry);
}

function user(roles: string[]): SessionClaims {
  return { sub: USER, tenantId: TENANT, roles, mfaVerified: true } as SessionClaims;
}

type Detail = ReturnType<typeof makeCourse>;
const contents = (detail: unknown) =>
  (detail as Detail).modules.flatMap((m) => m.lessons.map((l) => l.content));

describe('CoursesController.get — enmascarado del contenido', () => {
  it('quien gestiona cursos recibe todo, sin pasar por la regla', async () => {
    const course = makeCourse('DRAFT');
    const learning = makeLearning({ enrolled: false });
    const detail = await makeController(course, learning).get(user(['formador']), COURSE);
    expect(detail).toBe(course);
    expect(learning.hasActiveEnrollment).not.toHaveBeenCalled();
  });

  it('un alumno no ve un curso que no esté publicado', async () => {
    const ctrl = makeController(makeCourse('DRAFT'), makeLearning({ enrolled: true }));
    await expect(ctrl.get(user(['alumno']), COURSE)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sin matrícula: la estructura del curso, con TODO el contenido a null', async () => {
    const detail = await makeController(makeCourse(), makeLearning({ enrolled: false })).get(
      user(['alumno']),
      COURSE,
    );
    expect(contents(detail)).toEqual([null, null]);
    expect((detail as Detail).modules[0]!.lessons.map((l) => l.title)).toEqual([
      'Lección 1',
      'Lección 2',
    ]);
  });

  it('matriculado sin gating: el curso tal cual', async () => {
    const course = makeCourse();
    const detail = await makeController(course, makeLearning({ enrolled: true })).get(
      user(['alumno']),
      COURSE,
    );
    expect(detail).toBe(course);
  });

  it('matriculado con gating: a null solo las lecciones aún no liberadas', async () => {
    const detail = await makeController(
      makeCourse(),
      makeLearning({
        enrolled: true,
        availability: { drip: true, lessons: { l2: { available: false } } },
      }),
    ).get(user(['alumno']), COURSE);
    expect(contents(detail)).toEqual([VIDEO, null]);
  });
});
