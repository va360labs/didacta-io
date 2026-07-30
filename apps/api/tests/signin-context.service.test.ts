/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests de `SigninContextService`, el material del panel de marca de /signin.
 *
 * Lo que garantiza este spec (regla #3 del repo: cero datos de cartón):
 *  - Las cifras son COUNT reales filtrados por tenant, no constantes.
 *  - Sin copy configurado devuelve null, para que el web use su texto genérico
 *    en vez de inventar una frase por tenant.
 *  - Si la BD falla, /signin no se cae: contexto vacío y a seguir.
 */

import { describe, it, expect, vi } from 'vitest';
import { SigninContextService } from '../src/auth/signin-context.service';

type Ctor = ConstructorParameters<typeof SigninContextService>;

const TENANT = 'tenant-1';

function makeLogger(): Ctor[1] {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Ctor[1];
}

function makePrisma(opts: {
  theme?: {
    signinHeadline: string | null;
    signinSubheadline: string | null;
    brandHue: number;
    brandSaturation: number;
  } | null;
  users?: number;
  courses?: number;
  membershipActive?: boolean | null;
  fail?: boolean;
}) {
  const userCount = vi.fn().mockResolvedValue(opts.users ?? 0);
  const courseCount = vi.fn().mockResolvedValue(opts.courses ?? 0);
  const prisma = {
    modThemingTenantTheme: {
      findUnique: vi.fn().mockImplementation(async () => {
        if (opts.fail) throw new Error('db caída');
        return opts.theme ?? null;
      }),
    },
    user: { count: userCount },
    modCoursesCourse: { count: courseCount },
    modSubscriptionsMembershipConfig: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          opts.membershipActive === null || opts.membershipActive === undefined
            ? null
            : { active: opts.membershipActive },
        ),
    },
  };
  return { prisma: prisma as unknown as Ctor[0], userCount, courseCount };
}

describe('SigninContextService', () => {
  it('devuelve el copy del tenant y sus cifras reales', async () => {
    const { prisma, userCount, courseCount } = makePrisma({
      theme: {
        signinHeadline: 'Formación en IA aplicada.',
        signinSubheadline: 'Con la comunidad que la usa cada día.',
        brandHue: 24,
        brandSaturation: 90,
      },
      users: 112,
      courses: 11,
      membershipActive: true,
    });
    const service = new SigninContextService(prisma, makeLogger());

    const ctx = await service.get(TENANT);

    expect(ctx.headline).toBe('Formación en IA aplicada.');
    expect(ctx.subheadline).toBe('Con la comunidad que la usa cada día.');
    expect(ctx.brandHue).toBe(24);
    expect(ctx.brandSaturation).toBe(90);
    expect(ctx.stats).toEqual({ activeMembers: 112, publishedCourses: 11 });
    expect(ctx.membershipPageActive).toBe(true);

    // Las dos cifras se cuentan SIEMPRE acotadas al tenant (y sin borrados).
    expect(userCount).toHaveBeenCalledWith({
      where: { tenantId: TENANT, status: 'ACTIVE', deletedAt: null },
    });
    expect(courseCount).toHaveBeenCalledWith({
      where: { tenantId: TENANT, status: 'PUBLISHED', deletedAt: null },
    });
  });

  it('sin theme configurado: copy null y colores default Didacta', async () => {
    const { prisma } = makePrisma({ theme: null, users: 3, courses: 0 });
    const service = new SigninContextService(prisma, makeLogger());

    const ctx = await service.get(TENANT);

    expect(ctx.headline).toBeNull();
    expect(ctx.subheadline).toBeNull();
    expect(ctx.brandHue).toBe(213);
    expect(ctx.brandSaturation).toBe(70);
    expect(ctx.stats).toEqual({ activeMembers: 3, publishedCourses: 0 });
  });

  it('sin membresía configurada, el login no enlaza /unete', async () => {
    const { prisma } = makePrisma({ theme: null, membershipActive: null });
    const service = new SigninContextService(prisma, makeLogger());

    expect((await service.get(TENANT)).membershipPageActive).toBe(false);
  });

  it('si la consulta falla, /signin sigue en pie con contexto vacío', async () => {
    const { prisma } = makePrisma({ fail: true });
    const logger = makeLogger();
    const service = new SigninContextService(prisma, logger);

    const ctx = await service.get(TENANT);

    expect(ctx).toEqual({
      headline: null,
      subheadline: null,
      brandHue: 213,
      brandSaturation: 70,
      stats: { activeMembers: 0, publishedCourses: 0 },
      membershipPageActive: false,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});
