/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it, vi } from 'vitest';
import { CourseHasNoLessonsError, CourseSlugAlreadyExistsError } from '@didacta/mod-courses';
import { SimpleModeService } from '../src/simple-mode/simple-mode.service';
import {
  lessonHasContent,
  toCourseSlug,
  SimpleModeError,
} from '../src/simple-mode/simple-mode.model';

const T = '00000000-0000-4000-8000-0000000000aa';
const U = '00000000-0000-4000-8000-0000000000bb';

/** Mundo en memoria: lo justo de cada tabla que lee o escribe el servicio. */
function mundo(opts: { paymentsReady?: boolean } = {}) {
  const db = {
    tenant: { id: T, name: 'tenant-aa', simpleMode: true },
    user: { id: U, name: null as string | null, onboardingCompletedAt: null as Date | null },
    settings: new Map<string, unknown>(),
    courses: [] as Array<{
      id: string;
      slug: string;
      title: string;
      status: string;
      deletedAt: null;
      createdAt: Date;
    }>,
    modules: [] as Array<{ id: string; courseId: string; title: string }>,
    lessons: [] as Array<{ type: string; content: unknown; module: { courseId: string } }>,
    products: [] as Array<{
      id: string;
      courseId: string;
      active: boolean;
      unitAmount: number;
      currency: string;
    }>,
    plans: [] as Array<{
      id: string;
      name: string;
      amountCents: number;
      currency: string;
      active: boolean;
    }>,
    membershipActive: false,
    spaces: new Set<string>(),
    posts: [] as Array<{ title: string; authorId: string; tags: string[] }>,
    ordersCompleted: 0,
  };

  const prisma = {
    tenant: {
      findUnique: vi.fn(async () => db.tenant),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        Object.assign(db.tenant, data),
      ),
    },
    user: {
      findUnique: vi.fn(async () => db.user),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        Object.assign(db.user, data),
      ),
      count: vi.fn(async () => 0),
    },
    tenantSetting: {
      findUnique: vi.fn(
        async ({ where }: { where: { tenantId_moduleName_key: { key: string } } }) => {
          const v = db.settings.get(where.tenantId_moduleName_key.key);
          return v === undefined ? null : { valueJson: v };
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { tenantId_moduleName_key: { key: string } };
          create: { valueJson: unknown };
        }) => {
          db.settings.set(where.tenantId_moduleName_key.key, create.valueJson);
        },
      ),
    },
    modCoursesCourse: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id ? (db.courses.find((c) => c.id === where.id) ?? null) : (db.courses[0] ?? null),
      ),
    },
    modCoursesLesson: { findMany: vi.fn(async () => db.lessons) },
    modThemingTenantTheme: { findUnique: vi.fn(async () => null) },
    modBillingOrder: {
      count: vi.fn(async () => db.ordersCompleted),
      findFirst: vi.fn(async () =>
        db.ordersCompleted ? { completedAt: new Date('2026-11-12T10:00:00Z') } : null,
      ),
    },
    modSubscriptionsSubscription: { count: vi.fn(async () => 0) },
    modSubscriptionsMembershipConfig: {
      findUnique: vi.fn(async () => ({ active: db.membershipActive })),
    },
    modSubscriptionsPlan: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          db.plans.find((p) => p.id === where.id) ?? null,
      ),
    },
    modZoomSession: { findFirst: vi.fn(async () => null) },
    modCommunityPost: { findFirst: vi.fn(async () => (db.posts.length ? { id: 'p' } : null)) },
  };

  const courses = {
    createCourse: vi.fn(async (_t: string, _a: string, dto: { slug: string; title: string }) => {
      if (db.courses.some((c) => c.slug === dto.slug))
        throw new CourseSlugAlreadyExistsError(dto.slug);
      const c = {
        id: `c${db.courses.length + 1}`,
        slug: dto.slug,
        title: dto.title,
        status: 'DRAFT',
        deletedAt: null,
        createdAt: new Date(),
      };
      db.courses.push(c);
      return c;
    }),
    createModule: vi.fn(
      async (_t: string, _a: string, courseId: string, dto: { title: string }) => {
        const m = { id: `m${db.modules.length + 1}`, courseId, title: dto.title };
        db.modules.push(m);
        return m;
      },
    ),
    updateCourse: vi.fn(async (_t: string, _a: string, id: string, dto: { title: string }) => {
      Object.assign(db.courses.find((c) => c.id === id)!, dto);
    }),
    publishCourse: vi.fn(async (_t: string, _a: string, id: string) => {
      const c = db.courses.find((x) => x.id === id)!;
      if (!db.lessons.some((l) => l.module.courseId === id)) throw new CourseHasNoLessonsError();
      c.status = 'PUBLISHED';
    }),
  };
  const membership = {
    listPlans: vi.fn(async () => db.plans),
    createPlan: vi.fn(
      async (_t: string, input: { name: string; amountCents: number; currency: string }) => {
        const p = { id: `p${db.plans.length + 1}`, active: true, ...input };
        db.plans.push(p);
        return p;
      },
    ),
    updatePlan: vi.fn(async (_t: string, id: string, input: Record<string, unknown>) =>
      Object.assign(db.plans.find((p) => p.id === id)!, input),
    ),
    updateConfig: vi.fn(async (_t: string, input: { active: boolean }) => {
      db.membershipActive = input.active;
    }),
  };
  const billing = {
    listProducts: vi.fn(async () => db.products),
    upsertCoursePrice: vi.fn(
      async (input: { courseId: string; unitAmount: number; currency: string }) => {
        const p = db.products.find((x) => x.courseId === input.courseId);
        if (p)
          Object.assign(p, {
            unitAmount: input.unitAmount,
            currency: input.currency,
            active: true,
          });
        else
          db.products.push({
            id: `pr${db.products.length + 1}`,
            courseId: input.courseId,
            active: true,
            unitAmount: input.unitAmount,
            currency: input.currency,
          });
        return { product: db.products[0], accion: 'creado' };
      },
    ),
  };
  const community = {
    createSpace: vi.fn(async (_t: string, _a: string, dto: { slug: string }) => {
      db.spaces.add(dto.slug);
    }),
    createPost: vi.fn(
      async (_t: string, author: { id: string }, dto: { title: string; tags: string[] }) => {
        db.posts.push({ title: dto.title, authorId: author.id, tags: dto.tags });
      },
    ),
  };
  const registry = {
    getCoursesService: () => courses,
    getMembershipService: () => membership,
    getBillingService: () => billing,
    getCommunityService: () => community,
  };
  const stripeResolver = {
    resolve: vi.fn(async () => (opts.paymentsReady ? { secretKey: 'sk_test_x' } : null)),
  };
  const service = new SimpleModeService(
    prisma as never,
    registry as never,
    stripeResolver as never,
  );
  return { db, service, courses, billing, community, membership, stripeResolver };
}

const ALTA = {
  academyName: 'Taller de Acuarela',
  offer: 'course' as const,
  title: 'Acuarela desde cero',
  amountCents: 4900,
  currency: 'eur',
  locale: 'es' as const,
};

describe('utilidades del modo sencillo', () => {
  it('el enlace del curso sale del título, sin acentos ni símbolos', () => {
    expect(toCourseSlug('Acuarela desde cero')).toBe('acuarela-desde-cero');
    expect(toCourseSlug('¡Cómo pintar con ñ y ü!')).toBe('como-pintar-con-n-y-u');
    expect(toCourseSlug('***')).toBe('curso');
  });

  it('una lección recién creada (content {}) no cuenta como hecha', () => {
    expect(lessonHasContent('TEXT', {})).toBe(false);
    expect(lessonHasContent('TEXT', { text: 'Hola' })).toBe(true);
    expect(lessonHasContent('VIDEO', { videoUrl: '' })).toBe(false);
    expect(
      lessonHasContent('VIDEO', { videoUrl: 'https://iframe.mediadelivery.net/embed/1/2' }),
    ).toBe(true);
    expect(lessonHasContent('PDF', { pdfUrl: '/api/v1/storage/file/x.pdf' })).toBe(true);
  });
});

describe('alta en 3 preguntas', () => {
  it('deja filas reales: nombre, curso con apartado, precio, espacios y post de bienvenida', async () => {
    const { db, service } = mundo();
    await service.quickStart(T, { id: U }, ALTA);
    expect(db.tenant.name).toBe('Taller de Acuarela');
    expect(db.courses).toEqual([
      expect.objectContaining({
        slug: 'acuarela-desde-cero',
        title: 'Acuarela desde cero',
        status: 'DRAFT',
      }),
    ]);
    expect(db.modules).toHaveLength(1);
    expect(db.settings.get('offer')).toEqual({
      kind: 'course',
      courseId: 'c1',
      planId: null,
      amountCents: 4900,
      currency: 'eur',
    });
    expect([...db.spaces]).toEqual(['general', 'anuncios', 'preguntas']);
    expect(db.posts).toEqual([
      { title: 'Te doy la bienvenida a Taller de Acuarela', authorId: U, tags: ['general'] },
    ]);
    // Sin nombre de persona inventado: el creador firma con el nombre de su academia.
    expect(db.user.name).toBe('Taller de Acuarela');
    expect(db.user.onboardingCompletedAt).toBeInstanceOf(Date);
    // Sustituye al asistente antiguo: el shell ya no manda a /bienvenida.
    expect(db.settings.get('academy')).toMatchObject({ completedAt: expect.any(String) });
  });

  it('repetirla no duplica el curso ni el post: actualiza nombre y precio', async () => {
    const { db, service } = mundo();
    await service.quickStart(T, { id: U }, ALTA);
    await service.quickStart(
      T,
      { id: U },
      { ...ALTA, title: 'Acuarela para empezar', amountCents: 5900 },
    );
    expect(db.courses).toHaveLength(1);
    expect(db.courses[0]?.title).toBe('Acuarela para empezar');
    expect(db.posts).toHaveLength(1);
    expect((db.settings.get('offer') as { amountCents: number }).amountCents).toBe(5900);
  });

  it('si el enlace ya existe, prueba con otro', async () => {
    const { db, service } = mundo();
    db.courses.push({
      id: 'old',
      slug: 'acuarela-desde-cero',
      title: 'x',
      status: 'DRAFT',
      deletedAt: null,
      createdAt: new Date(),
    });
    await service.quickStart(T, { id: U }, ALTA);
    expect(db.courses.map((c) => c.slug)).toContain('acuarela-desde-cero-2');
  });

  it('rechaza una moneda que el aula no puede cobrar (con claves propias, CHF no)', async () => {
    const { service, courses } = mundo();
    await expect(
      service.quickStart(T, { id: U }, { ...ALTA, currency: 'chf' }),
    ).rejects.toMatchObject({
      code: 'SIMPLE_MODE_CURRENCY_NOT_SUPPORTED',
    });
    expect(courses.createCourse).not.toHaveBeenCalled();
  });

  it('membresía: crea el plan mensual sin encender la página de venta', async () => {
    const { db, service } = mundo();
    await service.quickStart(
      T,
      { id: U },
      { ...ALTA, offer: 'membership', title: 'Club de Acuarela', amountCents: 1200 },
    );
    expect(db.plans).toEqual([
      expect.objectContaining({ name: 'Club de Acuarela', amountCents: 1200, currency: 'eur' }),
    ]);
    expect(db.membershipActive).toBe(false);
    expect(db.courses).toHaveLength(0);
  });
});

describe('publicar', () => {
  it('sin cobros listos no publica: nadie podría pagar', async () => {
    const { service, courses } = mundo({ paymentsReady: false });
    await service.quickStart(T, { id: U }, ALTA);
    await expect(service.publish(T, U)).rejects.toMatchObject({
      code: 'SIMPLE_MODE_PAYMENTS_NOT_READY',
    });
    expect(courses.publishCourse).not.toHaveBeenCalled();
  });

  it('sin lecciones avisa en llano', async () => {
    const { service } = mundo({ paymentsReady: true });
    await service.quickStart(T, { id: U }, ALTA);
    const err = await service.publish(T, U).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimpleModeError);
    expect((err as SimpleModeError).code).toBe('SIMPLE_MODE_NO_LESSONS');
  });

  it('con lección y cobros: publica, pone el precio y devuelve el enlace de venta', async () => {
    const { db, service, billing } = mundo({ paymentsReady: true });
    await service.quickStart(T, { id: U }, ALTA);
    db.lessons.push({ type: 'TEXT', content: { text: 'Bienvenida' }, module: { courseId: 'c1' } });
    const { salePath } = await service.publish(T, U);
    expect(salePath).toBe('/catalogo/acuarela-desde-cero');
    expect(db.courses[0]?.status).toBe('PUBLISHED');
    expect(billing.upsertCoursePrice).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: 'c1',
        unitAmount: 4900,
        currency: 'eur',
        optionName: '',
      }),
    );
  });

  it('membresía: enciende /unete', async () => {
    const { db, service } = mundo({ paymentsReady: true });
    await service.quickStart(T, { id: U }, { ...ALTA, offer: 'membership' });
    expect((await service.publish(T, U)).salePath).toBe('/unete');
    expect(db.membershipActive).toBe(true);
  });
});

describe('Empieza aquí', () => {
  it('marca cada paso con datos reales, no con lo que dijo el asistente', async () => {
    const { db, service } = mundo({ paymentsReady: false });
    await service.quickStart(T, { id: U }, ALTA);
    let view = await service.startHere(T);
    expect(Object.fromEntries(view.steps.map((s) => [s.id, s.done]))).toEqual({
      // El alta ya le dio nombre; logo y color son opcionales (Didacta por defecto).
      academy: true,
      course: false,
      price: true,
      payments: false,
      publish: false,
      invite: false,
    });
    expect(view.salePath).toBeNull();
    // Sin cobros de plataforma, los cobros se conectan con las claves propias.
    expect(view.paymentsSetupPath).toBe('/admin/configuracion?tab=pagos');

    // Una lección VACÍA no completa el paso; con texto, sí.
    db.lessons.push({ type: 'TEXT', content: {}, module: { courseId: 'c1' } });
    view = await service.startHere(T);
    expect(view.steps.find((s) => s.id === 'course')?.done).toBe(false);
    db.lessons.push({ type: 'TEXT', content: { text: 'Hola' }, module: { courseId: 'c1' } });
    view = await service.startHere(T);
    expect(view.steps.find((s) => s.id === 'course')?.done).toBe(true);

    // Sin alta, la academia no está hecha hasta confirmarla o personalizarla.
    db.settings.set('state', {});
    expect((await service.startHere(T)).steps.find((s) => s.id === 'academy')?.done).toBe(false);
    await service.confirmAcademy(T, U);
    expect((await service.startHere(T)).steps.find((s) => s.id === 'academy')?.done).toBe(true);
  });

  it('tras publicar da el enlace y, con una venta, la cuenta', async () => {
    const { db, service } = mundo({ paymentsReady: true });
    await service.quickStart(T, { id: U }, ALTA);
    db.lessons.push({ type: 'TEXT', content: { text: 'Hola' }, module: { courseId: 'c1' } });
    await service.publish(T, U);
    db.ordersCompleted = 1;
    const view = await service.startHere(T);
    expect(view.salePath).toBe('/catalogo/acuarela-desde-cero');
    expect(view.steps.find((s) => s.id === 'publish')?.done).toBe(true);
    expect(view.sales).toEqual({ count: 1, firstSaleAt: '2026-11-12T10:00:00.000Z' });
    expect(view.steps.find((s) => s.id === 'invite')?.done).toBe(true);
  });

  it('publicado pero con los cobros caídos: el paso de publicar NO cuenta como hecho', async () => {
    const { db, service, stripeResolver } = mundo({ paymentsReady: true });
    await service.quickStart(T, { id: U }, ALTA);
    db.lessons.push({ type: 'TEXT', content: { text: 'Hola' }, module: { courseId: 'c1' } });
    await service.publish(T, U);
    stripeResolver.resolve.mockResolvedValue(null as never);
    const view = await service.startHere(T);
    expect(view.salePath).toBe('/catalogo/acuarela-desde-cero');
    expect(view.steps.find((s) => s.id === 'payments')?.done).toBe(false);
    expect(view.steps.find((s) => s.id === 'publish')?.done).toBe(false);
  });
});
