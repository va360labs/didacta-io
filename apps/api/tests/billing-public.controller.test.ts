import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { StripeConfigMissingError } from '@didacta/mod-billing';
import { BillingPublicController } from '../src/modules/billing/billing-public.controller';
import { resolveWebBaseUrl, type RequestLike } from '../src/common/resolve-web-base-url';

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
    modCoursesCourse: {
      findMany: vi.fn().mockResolvedValue(opts?.courses ?? []),
      findFirst: vi
        .fn()
        .mockResolvedValue(opts?.courseFirst === undefined ? null : opts.courseFirst),
    },
  } as never;
  return {
    controller: new BillingPublicController(registry, tenantResolver, prisma),
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

  it('inicia el checkout SIN usuario, con retorno a las páginas públicas /catalogo', async () => {
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
    expect(args.successUrl).toContain('/catalogo/checkout/success?session_id=');
    expect(args.cancelUrl).toContain('/catalogo/checkout/cancel');
  });
});
