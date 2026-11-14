import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { StripeConfigMissingError } from '@didacta/mod-billing';
import { BillingPublicController } from '../src/modules/billing/billing-public.controller';
import { PlatformCheckoutGate } from '../src/modules/payouts/platform-checkout-gate';
import { resolveWebBaseUrl, type RequestLike } from '../src/common/resolve-web-base-url';
import { fakeConsents } from './helpers/fake-purchase-consent';

/**
 * Tests unit del controller PÚBLICO de mod.billing (viaje 2): tenant por Host,
 * catálogo/oferta (no dependen de Stripe, siempre disponibles) y guardas del
 * checkout anónimo (sí depende de Stripe — falla per-tenant, no per-boot).
 */

const TENANT = 'tenant-1';
const COURSE = '11111111-1111-4111-8111-111111111111';

const req = (host = 'academia.example.com') => ({ headers: { host } }) as never;

function makeController(opts?: {
  billing?: Record<string, unknown>;
  courses?: Array<Record<string, unknown>>;
  courseFirst?: Record<string, unknown> | null;
  tenant?: { id: string } | null;
  signupsFrozenAt?: Date | null;
  gate?: PlatformCheckoutGate;
  sections?: Array<{ id: string; courseId: string; title: string }>;
  lessons?: Array<{ moduleId: string; title: string }>;
}) {
  const billing = opts?.billing ?? {
    getCatalog: vi.fn().mockResolvedValue([]),
    getCourseOffer: vi.fn().mockResolvedValue({ forSale: true, options: [] }),
    startCheckout: vi
      .fn()
      .mockResolvedValue({ orderId: 'ord-1', sessionId: 'cs_1', url: 'https://stripe/cs_1' }),
  };
  const registry = {
    getBillingService: () => billing,
  } as never;
  const tenantResolver = {
    resolveByHost: vi
      .fn()
      .mockResolvedValue(opts?.tenant === undefined ? { id: TENANT } : opts.tenant),
    // Sin BD real en este harness: delega en la misma cascada pura que usaba
    // el controller antes de F5 (env → Host del request → localhost).
    resolveTenantWebBaseUrl: vi.fn(async (_tenantId: string | null, req?: RequestLike) =>
      resolveWebBaseUrl(req),
    ),
  } as never;
  const prisma = {
    // U7: el tenant de este harness admite altas, que es el estado por defecto
    // de cualquier instalación. El caso congelado se prueba en
    // `signup-freeze.test.ts`.
    tenant: {
      findUnique: vi.fn().mockResolvedValue({
        signupsFrozenAt: opts?.signupsFrozenAt ?? null,
        signupsFrozenReason: null,
      }),
    },
    modCoursesCourse: {
      findMany: vi.fn().mockResolvedValue(opts?.courses ?? []),
      findFirst: vi
        .fn()
        .mockResolvedValue(opts?.courseFirst === undefined ? null : opts.courseFirst),
    },
    modCoursesModule: { findMany: vi.fn().mockResolvedValue(opts?.sections ?? []) },
    modCoursesLesson: { findMany: vi.fn().mockResolvedValue(opts?.lessons ?? []) },
  } as never;
  return {
    controller: new BillingPublicController(
      registry,
      tenantResolver,
      prisma,
      fakeConsents() as never,
      opts?.gate,
    ),
    billing,
    prisma,
  };
}

beforeEach(() => {
  // resolveWebBaseUrl prioriza WEB_PUBLIC_URL: fuera para que derive del Host.
  delete process.env.WEB_PUBLIC_URL;
});

describe('BillingPublicController — tenant por Host', () => {
  it('404 si el dominio no corresponde a ninguna comunidad', async () => {
    const { controller } = makeController({ tenant: null });
    await expect(controller.catalog(req('desconocido.example.com'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('BillingPublicController — catálogo público', () => {
  it('solo expone cursos PUBLISHED: cruza las ofertas del módulo con mod.courses', async () => {
    const options = [{ id: 'opt-1', name: '', unitAmount: 9900 }];
    const { controller, prisma } = makeController({
      billing: {
        getCatalog: vi.fn().mockResolvedValue([
          { courseId: COURSE, options },
          { courseId: '22222222-2222-4222-8222-222222222222', options: [] },
        ]),
      },
      courses: [
        {
          id: COURSE,
          slug: 'curso-uno',
          title: 'Curso Uno',
          description: null,
          thumbnailUrl: null,
          category: null,
          estimatedMinutes: 90,
        },
      ],
    });

    const result = await controller.catalog(req());

    expect(result.courses).toHaveLength(1);
    expect(result.courses[0]!.slug).toBe('curso-uno');
    expect(result.courses[0]!.options).toBe(options);
    // La query al core filtra por tenant y estado publicado (nunca borrados).
    const where = (prisma as never as { modCoursesCourse: { findMany: ReturnType<typeof vi.fn> } })
      .modCoursesCourse.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ tenantId: TENANT, status: 'PUBLISHED', deletedAt: null });
  });
});

describe('BillingPublicController — catálogo público · descripción para pintar en el servidor', () => {
  it('descriptionHtml sale saneado por la frontera del servidor (sin scripts ni manejadores)', async () => {
    const { controller } = makeController({
      billing: {
        getCatalog: vi
          .fn()
          .mockResolvedValue([{ courseId: COURSE, options: [{ id: 'o', unitAmount: 100 }] }]),
      },
      courses: [
        {
          id: COURSE,
          slug: 'curso-uno',
          title: 'Curso Uno',
          description:
            '<p>Hola <strong>mundo</strong></p><img src="x" onerror="alert(1)"><script>robar()</script>',
          thumbnailUrl: null,
          category: null,
          estimatedMinutes: null,
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          slug: 'sin-descripcion',
          title: 'Sin descripción',
          description: null,
          thumbnailUrl: null,
          category: null,
          estimatedMinutes: null,
        },
      ],
    });
    const { courses } = await controller.catalog(req());
    const html = courses[0]!.descriptionHtml!;
    expect(html).toContain('<p>Hola <strong>mundo</strong></p>');
    expect(html).not.toMatch(/onerror|<script|robar/);
    // El original se sigue sirviendo tal cual (el navegador lo sanea al pintarlo).
    expect(courses[0]!.description).toContain('<script>');
    expect(courses[1]!.descriptionHtml).toBeNull();
  });
});

describe('BillingPublicController — temario en la ficha pública (ensayo general)', () => {
  const curso = {
    id: COURSE,
    slug: 'torno',
    title: 'Torno para principiantes',
    description: null,
    thumbnailUrl: null,
    category: null,
    estimatedMinutes: null,
  };
  const billing = {
    getCatalog: vi.fn().mockResolvedValue([{ courseId: COURSE, options: [] }]),
  };

  it('cada curso lleva sus secciones con los TÍTULOS de las lecciones, en orden', async () => {
    const { controller, prisma } = makeController({
      billing,
      courses: [curso],
      sections: [
        { id: 'm1', courseId: COURSE, title: 'Lecciones' },
        { id: 'm-vacia', courseId: COURSE, title: 'Sin nada dentro' },
      ],
      lessons: [
        { moduleId: 'm1', title: 'Bienvenida al torno' },
        { moduleId: 'm1', title: 'Centrar el barro' },
      ],
    });
    const result = await controller.catalog(req());
    // Una sección sin lecciones no se enseña.
    expect(result.courses[0]!.syllabus).toEqual([
      { title: 'Lecciones', lessons: ['Bienvenida al torno', 'Centrar el barro'] },
    ]);
    // Acotado al aula y sin borradas, en las DOS consultas.
    const p = prisma as never as {
      modCoursesModule: { findMany: ReturnType<typeof vi.fn> };
      modCoursesLesson: { findMany: ReturnType<typeof vi.fn> };
    };
    expect(p.modCoursesModule.findMany.mock.calls[0]![0].where).toMatchObject({
      tenantId: TENANT,
      deletedAt: null,
    });
    expect(p.modCoursesLesson.findMany.mock.calls[0]![0].where).toMatchObject({
      tenantId: TENANT,
      deletedAt: null,
    });
    // Solo títulos: el contenido de la lección no sale del aula.
    expect(p.modCoursesLesson.findMany.mock.calls[0]![0].select).toEqual({
      moduleId: true,
      title: true,
    });
  });

  it('CONTROL: un curso sin lecciones lleva el temario vacío', async () => {
    const { controller } = makeController({ billing, courses: [curso] });
    expect((await controller.catalog(req())).courses[0]!.syllabus).toEqual([]);
  });
});

describe('BillingPublicController — oferta pública', () => {
  it('un courseId que no es UUID es un curso que no existe (404, no 500 de Prisma)', async () => {
    const { controller } = makeController();
    await expect(controller.offer(req(), 'no-soy-uuid')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('curso no publicado (o inexistente): forSale=false sin filtrar si existe', async () => {
    const { controller, billing } = makeController({ courseFirst: null });
    await expect(controller.offer(req(), COURSE)).resolves.toEqual({
      forSale: false,
      options: [],
    });
    expect(
      (billing as { getCourseOffer: ReturnType<typeof vi.fn> }).getCourseOffer,
    ).not.toHaveBeenCalled();
  });

  it('curso publicado: devuelve la oferta del módulo', async () => {
    const { controller } = makeController({ courseFirst: { id: COURSE } });
    await expect(controller.offer(req(), COURSE)).resolves.toEqual({ forSale: true, options: [] });
  });
});

describe('BillingPublicController — checkout anónimo', () => {
  it('404 si el curso no existe en el tenant', async () => {
    const { controller } = makeController({ courseFirst: null });
    await expect(controller.checkout(req(), COURSE, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409 si el curso no está publicado (no se cobra por algo inmatriculable)', async () => {
    const { controller } = makeController({ courseFirst: { status: 'DRAFT' } });
    await expect(controller.checkout(req(), COURSE, {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('sin Stripe configurado para este tenant, el fallo sale de startCheckout (BillingErrorFilter lo mapea a 503)', async () => {
    const { controller } = makeController({
      billing: {
        startCheckout: vi.fn().mockRejectedValue(new StripeConfigMissingError('secretKey')),
      },
      courseFirst: { status: 'PUBLISHED' },
    });
    await expect(controller.checkout(req(), COURSE, {})).rejects.toBeInstanceOf(
      StripeConfigMissingError,
    );
  });

  it('U7: con las altas congeladas no se llega a cobrar', async () => {
    // La comprobación va ANTES que ninguna otra guarda: cobrarle a alguien que
    // después no va a poder entrar es el peor orden posible.
    const { controller, billing } = makeController({
      courseFirst: { status: 'PUBLISHED' },
      signupsFrozenAt: new Date(),
    });

    await expect(controller.checkout(req(), COURSE, {})).rejects.toMatchObject({
      response: { code: 'TENANT_SIGNUPS_FROZEN' },
    });
    expect(
      (billing as { startCheckout: ReturnType<typeof vi.fn> }).startCheckout,
    ).not.toHaveBeenCalled();
  });

  it('inicia el checkout SIN usuario, con retorno a las páginas públicas /catalog', async () => {
    const { controller, billing } = makeController({ courseFirst: { status: 'PUBLISHED' } });

    const result = await controller.checkout(req(), COURSE, {
      optionId: '33333333-3333-4333-8333-333333333333',
      email: 'visitante@example.com',
    });

    // Al visitante solo se le devuelve lo que necesita para redirigir.
    expect(result).toEqual({ url: 'https://stripe/cs_1', sessionId: 'cs_1' });
    const args = (billing as { startCheckout: ReturnType<typeof vi.fn> }).startCheckout.mock
      .calls[0]![0];
    expect(args.userId).toBeNull();
    expect(args.userEmail).toBe('visitante@example.com');
    expect(args.optionId).toBe('33333333-3333-4333-8333-333333333333');
    expect(args.successUrl).toContain('/catalog/checkout/success?session_id=');
    expect(args.cancelUrl).toContain('/catalog/checkout/cancel');
  });
});

/**
 * Cobros de plataforma: cada opción dice si el alumno la verá en su moneda al
 * pagar (Adaptive Pricing solo convierte la moneda de liquidación del creador).
 * Sin el modo plataforma (Community) no aparece el campo.
 */
describe('BillingPublicController — «lo verás en tu moneda» (localCurrencyAtCheckout)', () => {
  const EUR = { id: 'opt-eur', name: '', unitAmount: 9900, currency: 'eur' };
  const USD = { id: 'opt-usd', name: 'Pro', unitAmount: 19900, currency: 'usd' };
  const CURSO = {
    id: COURSE,
    slug: 'curso-uno',
    title: 'Curso Uno',
    description: null,
    thumbnailUrl: null,
    category: null,
    estimatedMinutes: 90,
  };

  function gate(mode: 'ready' | 'own' | 'not_ready') {
    return new PlatformCheckoutGate({
      mode: {
        resolve: async () =>
          mode === 'own'
            ? { mode: 'own', credentials: {} }
            : mode === 'ready'
              ? { mode: 'platform', ready: true, stripeAccountId: 'acct_1', country: 'ES' }
              : { mode: 'platform', ready: false, reason: 'onboarding_incomplete' },
      },
      accounts: { getAccount: async () => ({ country: 'ES', defaultCurrency: 'eur' }) },
    } as never);
  }
  const billing = () => ({
    getCatalog: vi.fn().mockResolvedValue([{ courseId: COURSE, options: [EUR, USD] }]),
    getCourseOffer: vi.fn().mockResolvedValue({ forSale: true, options: [EUR, USD] }),
  });

  it('modo plataforma: solo el precio en la moneda de liquidación lo verá en su moneda', async () => {
    const { controller } = makeController({
      billing: billing(),
      courses: [CURSO],
      courseFirst: { id: COURSE },
      gate: gate('ready'),
    });
    const expected = [
      { ...EUR, localCurrencyAtCheckout: true },
      { ...USD, localCurrencyAtCheckout: false },
    ];
    expect((await controller.catalog(req())).courses[0]!.options).toEqual(expected);
    expect(await controller.offer(req(), COURSE)).toEqual({ forSale: true, options: expected });
  });

  it('claves propias con el modo encendido: el campo va siempre a false', async () => {
    const { controller } = makeController({
      billing: billing(),
      courses: [CURSO],
      courseFirst: { id: COURSE },
      gate: gate('own'),
    });
    const options = (await controller.catalog(req())).courses[0]!.options;
    expect(options.map((o) => o.localCurrencyAtCheckout)).toEqual([false, false]);
  });

  it('cuenta aún no lista: nada a la venta (como antes)', async () => {
    const { controller } = makeController({
      billing: billing(),
      courses: [CURSO],
      courseFirst: { id: COURSE },
      gate: gate('not_ready'),
    });
    expect(await controller.catalog(req())).toEqual({ courses: [] });
    expect(await controller.offer(req(), COURSE)).toMatchObject({ forSale: false, options: [] });
  });

  it('sin modo plataforma (Community): opciones idénticas, sin el campo nuevo', async () => {
    const b = billing();
    const { controller } = makeController({
      billing: b,
      courses: [CURSO],
      courseFirst: { id: COURSE },
    });
    const options = (await controller.catalog(req())).courses[0]!.options;
    expect(options).toEqual([EUR, USD]);
    expect(options[0]).not.toHaveProperty('localCurrencyAtCheckout');
    expect(await controller.offer(req(), COURSE)).toEqual({ forSale: true, options: [EUR, USD] });
  });
});
