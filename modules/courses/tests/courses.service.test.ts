import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleContext } from '@didacta/core-kernel';
import { CoursesService } from '../src/courses.service';
import {
  CourseAlreadyPublishedError,
  CourseHasNoLessonsError,
  CourseNotFoundError,
  CourseSlugAlreadyExistsError,
  PublishValidationError,
} from '../src/errors';

interface FakeCourse {
  id: string;
  tenantId: string;
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt: Date | null;
  deletedAt: Date | null;
}

function makeFakePrisma() {
  const courses = new Map<string, FakeCourse>();
  const modules = new Map<string, { id: string; tenantId: string; courseId: string }>();
  const lessons = new Map<string, { id: string; tenantId: string; moduleId: string }>();
  let counter = 0;
  const id = (prefix = 'id') => `${prefix}-${++counter}`;

  const prisma = {
    modCoursesCourse: {
      findUnique: vi.fn(
        async ({ where }: { where: { tenantId_slug?: { tenantId: string; slug: string } } }) => {
          if (!where.tenantId_slug) return null;
          return (
            [...courses.values()].find(
              (c) =>
                c.tenantId === where.tenantId_slug?.tenantId &&
                c.slug === where.tenantId_slug.slug &&
                c.deletedAt === null,
            ) ?? null
          );
        },
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string; tenantId?: string; deletedAt?: null } }) => {
          return (
            [...courses.values()].find(
              (c) =>
                (where.id === undefined || c.id === where.id) &&
                (where.tenantId === undefined || c.tenantId === where.tenantId) &&
                c.deletedAt === null,
            ) ?? null
          );
        },
      ),
      findMany: vi.fn(
        async (
          args: {
            where?: {
              tenantId?: string;
              deletedAt?: null;
              status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
              category?: string | { not: null };
              OR?: Array<{
                title?: { contains: string; mode?: string };
                description?: { contains: string; mode?: string };
              }>;
            };
            select?: { category?: boolean };
            distinct?: string[];
          } = {},
        ) => {
          const w = args.where ?? {};
          let rows = [...courses.values()].filter((c) => c.deletedAt === null);
          if (w.tenantId !== undefined) rows = rows.filter((c) => c.tenantId === w.tenantId);
          if (w.status !== undefined) rows = rows.filter((c) => c.status === w.status);
          if (typeof w.category === 'string') {
            rows = rows.filter((c) => c.category === w.category);
          } else if (w.category && 'not' in w.category && w.category.not === null) {
            rows = rows.filter((c) => c.category !== null);
          }
          if (w.OR && w.OR.length > 0) {
            rows = rows.filter((c) =>
              w.OR!.some((clause) => {
                if (clause.title?.contains) {
                  const needle = clause.title.contains.toLowerCase();
                  if (c.title.toLowerCase().includes(needle)) return true;
                }
                if (clause.description?.contains) {
                  const needle = clause.description.contains.toLowerCase();
                  if ((c.description ?? '').toLowerCase().includes(needle)) return true;
                }
                return false;
              }),
            );
          }
          if (args.distinct?.includes('category')) {
            const seen = new Set<string | null>();
            rows = rows.filter((c) => {
              if (seen.has(c.category)) return false;
              seen.add(c.category);
              return true;
            });
          }
          return rows;
        },
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Partial<FakeCourse> & { tenantId: string; slug: string; title: string };
        }) => {
          const created: FakeCourse = {
            id: id('course'),
            tenantId: data.tenantId,
            slug: data.slug,
            title: data.title,
            description: data.description ?? null,
            category: data.category ?? null,
            status: 'DRAFT',
            publishedAt: null,
            deletedAt: null,
          };
          courses.set(created.id, created);
          return created;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<FakeCourse> }) => {
          const current = courses.get(where.id);
          if (!current) throw new Error('not found');
          const merged = { ...current, ...data } as FakeCourse;
          courses.set(where.id, merged);
          return merged;
        },
      ),
    },
    modCoursesModule: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
        return [...modules.values()].find((m) => m.id === where.id) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: { tenantId: string; courseId: string } }) => {
        const m = { id: id('mod'), tenantId: data.tenantId, courseId: data.courseId };
        modules.set(m.id, m);
        return m;
      }),
    },
    modCoursesLesson: {
      count: vi.fn(async () => lessons.size),
      create: vi.fn(async ({ data }: { data: { tenantId: string; moduleId: string } }) => {
        const l = { id: id('lesson'), tenantId: data.tenantId, moduleId: data.moduleId };
        lessons.set(l.id, l);
        return l;
      }),
    },
  };

  return { prisma, lessons, courses };
}

function makeContext(): ModuleContext {
  return {
    eventBus: { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as never,
    hookRegistry: { register: vi.fn(), run: vi.fn().mockResolvedValue(undefined) } as never,
    storage: {} as never,
    auditLog: { record: vi.fn() } as never,
    evidenceVault: { store: vi.fn() } as never,
    notificationHub: { send: vi.fn() } as never,
    i18n: { t: (k: string) => k } as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    } as never,
    config: { get: vi.fn(), set: vi.fn() } as never,
  };
}

describe('CoursesService', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('crea curso y emite courses.course.created', async () => {
    const { prisma } = makeFakePrisma();
    const ctx = makeContext();
    const service = new CoursesService(prisma as never, ctx);

    const course = await service.createCourse('t-1', 'u-1', {
      slug: 'introduccion-n8n',
      title: 'Introducción a n8n',
      language: 'es-ES',
    });

    expect(course.slug).toBe('introduccion-n8n');
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'courses.course.created',
        data: { courseId: course.id },
        metadata: expect.objectContaining({ tenantId: 't-1' }),
      }),
    );
  });

  it('rechaza slug duplicado en el mismo tenant', async () => {
    const { prisma } = makeFakePrisma();
    const service = new CoursesService(prisma as never, makeContext());
    await service.createCourse('t-1', null, { slug: 'foo', title: 'Foo', language: 'es-ES' });
    await expect(
      service.createCourse('t-1', null, { slug: 'foo', title: 'Otro', language: 'es-ES' }),
    ).rejects.toBeInstanceOf(CourseSlugAlreadyExistsError);
  });

  it('publishCourse rechaza si no hay lecciones', async () => {
    const { prisma } = makeFakePrisma();
    const service = new CoursesService(prisma as never, makeContext());
    const course = await service.createCourse('t-1', null, {
      slug: 's',
      title: 't',
      language: 'es-ES',
    });
    await expect(service.publishCourse('t-1', null, course.id)).rejects.toBeInstanceOf(
      CourseHasNoLessonsError,
    );
  });

  it('publishCourse corre el hook courses.publish.validate y bloquea con razones', async () => {
    const { prisma, lessons } = makeFakePrisma();
    const ctx = makeContext();
    lessons.set('l-1', { id: 'l-1', tenantId: 't-1', moduleId: 'm-1' });
    (ctx.hookRegistry.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (_name: string, hookCtx: { input: { reasons: string[] } }) => {
        hookCtx.input.reasons.push('Falta objetivo Fundae');
      },
    );
    const service = new CoursesService(prisma as never, ctx);
    const course = await service.createCourse('t-1', null, {
      slug: 's',
      title: 't',
      language: 'es-ES',
    });
    await expect(service.publishCourse('t-1', null, course.id)).rejects.toBeInstanceOf(
      PublishValidationError,
    );
  });

  it('publishCourse marca PUBLISHED y emite evento si validaciones pasan', async () => {
    const { prisma, lessons } = makeFakePrisma();
    const ctx = makeContext();
    lessons.set('l-1', { id: 'l-1', tenantId: 't-1', moduleId: 'm-1' });
    const service = new CoursesService(prisma as never, ctx);
    const course = await service.createCourse('t-1', null, {
      slug: 's',
      title: 't',
      language: 'es-ES',
    });
    const published = await service.publishCourse('t-1', null, course.id);
    expect(published.status).toBe('PUBLISHED');
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'courses.course.published' }),
    );
  });

  it('publishCourse rechaza si ya está publicado', async () => {
    const { prisma, lessons } = makeFakePrisma();
    const ctx = makeContext();
    lessons.set('l-1', { id: 'l-1', tenantId: 't-1', moduleId: 'm-1' });
    const service = new CoursesService(prisma as never, ctx);
    const course = await service.createCourse('t-1', null, {
      slug: 's',
      title: 't',
      language: 'es-ES',
    });
    await service.publishCourse('t-1', null, course.id);
    await expect(service.publishCourse('t-1', null, course.id)).rejects.toBeInstanceOf(
      CourseAlreadyPublishedError,
    );
  });

  it('unarchiveCourse vuelve ARCHIVED → DRAFT y emite courses.course.unarchived', async () => {
    const { prisma, courses } = makeFakePrisma();
    const ctx = makeContext();
    const service = new CoursesService(prisma as never, ctx);
    const course = await service.createCourse('t-1', null, {
      slug: 'a',
      title: 't',
      language: 'es-ES',
    });
    await service.archiveCourse('t-1', null, course.id);
    expect(courses.get(course.id)!.status).toBe('ARCHIVED');

    const restored = await service.unarchiveCourse('t-1', null, course.id);
    expect(restored.status).toBe('DRAFT');
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'courses.course.unarchived' }),
    );
  });

  it('unarchiveCourse es idempotente si el curso no está ARCHIVED', async () => {
    const { prisma } = makeFakePrisma();
    const ctx = makeContext();
    const service = new CoursesService(prisma as never, ctx);
    const course = await service.createCourse('t-1', null, {
      slug: 'a',
      title: 't',
      language: 'es-ES',
    });
    // Está en DRAFT → unarchive no cambia estado ni emite evento.
    const same = await service.unarchiveCourse('t-1', null, course.id);
    expect(same.status).toBe('DRAFT');
    expect(ctx.eventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'courses.course.unarchived' }),
    );
  });

  it('updateCourse falla si el curso no existe', async () => {
    const { prisma } = makeFakePrisma();
    const service = new CoursesService(prisma as never, makeContext());
    await expect(
      service.updateCourse('t-1', null, 'no-existe', { title: 'x' }),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
  });

  it('listCourses filtra por texto en título y descripción (case insensitive)', async () => {
    const { prisma, courses } = makeFakePrisma();
    const service = new CoursesService(prisma as never, makeContext());
    const c1 = await service.createCourse('t-1', null, {
      slug: 'a',
      title: 'Introducción a n8n',
      description: 'Workflow automation',
      language: 'es-ES',
    });
    const c2 = await service.createCourse('t-1', null, {
      slug: 'b',
      title: 'Liderazgo de equipos',
      description: 'Gestión de personas y N8N como ejemplo',
      language: 'es-ES',
    });
    const c3 = await service.createCourse('t-1', null, {
      slug: 'c',
      title: 'Excel avanzado',
      description: 'Tablas dinámicas',
      language: 'es-ES',
    });
    // Forzamos PUBLISHED via mutación directa para evitar el flujo
    // completo de publishCourse en tests de filtros.
    for (const id of [c1.id, c2.id, c3.id]) {
      const cur = courses.get(id)!;
      courses.set(id, { ...cur, status: 'PUBLISHED' });
    }

    const matches = await service.listCourses('t-1', { q: 'n8n' });
    const slugs = matches.map((c) => c.slug).sort();
    expect(slugs).toEqual(['a', 'b']);
  });

  it('listCourses filtra por categoría exacta', async () => {
    const { prisma, courses } = makeFakePrisma();
    const service = new CoursesService(prisma as never, makeContext());
    const c1 = await service.createCourse('t-1', null, {
      slug: 'a',
      title: 'Curso A',
      category: 'Tecnología',
      language: 'es-ES',
    });
    const c2 = await service.createCourse('t-1', null, {
      slug: 'b',
      title: 'Curso B',
      category: 'Liderazgo',
      language: 'es-ES',
    });
    for (const id of [c1.id, c2.id]) {
      const cur = courses.get(id)!;
      courses.set(id, { ...cur, status: 'PUBLISHED' });
    }

    const tec = await service.listCourses('t-1', { category: 'Tecnología' });
    expect(tec.map((c) => c.slug)).toEqual(['a']);
  });

  it('listCategories devuelve categorías distintas de cursos publicados', async () => {
    const { prisma, courses } = makeFakePrisma();
    const service = new CoursesService(prisma as never, makeContext());
    const c1 = await service.createCourse('t-1', null, {
      slug: 'a',
      title: 'A',
      category: 'Tecnología',
      language: 'es-ES',
    });
    const c2 = await service.createCourse('t-1', null, {
      slug: 'b',
      title: 'B',
      category: 'Liderazgo',
      language: 'es-ES',
    });
    const c3 = await service.createCourse('t-1', null, {
      slug: 'c',
      title: 'C',
      category: 'Tecnología',
      language: 'es-ES',
    });
    // c4 sin categoría — no debería aparecer.
    const c4 = await service.createCourse('t-1', null, {
      slug: 'd',
      title: 'D',
      language: 'es-ES',
    });
    // c5 borrador con categoría — no debería aparecer.
    const c5 = await service.createCourse('t-1', null, {
      slug: 'e',
      title: 'E',
      category: 'Marketing',
      language: 'es-ES',
    });
    for (const id of [c1.id, c2.id, c3.id, c4.id]) {
      const cur = courses.get(id)!;
      courses.set(id, { ...cur, status: 'PUBLISHED' });
    }
    // c5 queda en DRAFT a propósito.
    void c5;

    const cats = await service.listCategories('t-1');
    expect(cats.sort()).toEqual(['Liderazgo', 'Tecnología']);
  });
});
