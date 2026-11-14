/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Página pública de la academia (`GET /public/academy-home`):
 *  - el aula sale SOLO del dominio (404 si no es de nadie; ni query ni body);
 *  - con el ajuste apagado no sale ningún dato;
 *  - la caché es por aula: lo de un aula nunca se sirve en otra;
 *  - solo datos publicables (ni caras ni nombres de alumnos, ni enlaces de sala);
 *  - nada a la venta si las altas están congeladas o la cuenta de cobros no puede vender.
 */

import { NotFoundException } from '@nestjs/common';
import { MembershipPageInactiveError } from '@didacta/mod-subscriptions';
import { describe, expect, it } from 'vitest';
import {
  defaultPublicHome,
  parsePublicHomeSetting,
  resolvePublicHome,
} from '../src/common/academy-public-home';
import { AcademyHomeController } from '../src/public/academy-home.controller';
import {
  ACADEMY_HOME_CACHE_TTL_MS,
  ACADEMY_HOME_MAX_COURSES,
  AcademyHomeService,
} from '../src/public/academy-home.service';

type Row = Record<string, unknown>;

interface TenantFixture {
  name: string;
  simpleMode: boolean;
  frozen?: boolean;
  publicHome?: unknown;
  theme?: Row;
  host?: string;
  students: number;
  staff: number;
  creator?: { name: string | null; avatarUrl: string | null } | null;
  sessions?: Array<{ topic: string; startTime: Date; durationMinutes: number; status: string }>;
  courses?: Array<{
    id: string;
    slug: string;
    title: string;
    description?: string | null;
    published?: boolean;
    price?: number;
  }>;
  membership?: 'inactive' | { plans: number; headline?: string };
  registration?: boolean;
  modules?: string[];
}

const ALL_MODULES = [
  'mod.billing',
  'mod.subscriptions',
  'mod.zoom-live',
  'mod.member-registration',
];

function world(tenants: Record<string, TenantFixture>) {
  const calls = { catalog: 0 };
  const t = (id: string) => {
    const f = tenants[id];
    if (!f) throw new Error(`aula desconocida ${id}`);
    return f;
  };
  const prisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const f = tenants[where.id];
        if (!f) return null;
        return {
          name: f.name,
          simpleMode: f.simpleMode,
          signupsFrozenAt: f.frozen ? new Date() : null,
          signupsFrozenReason: null,
        };
      },
    },
    tenantSetting: {
      findUnique: async ({
        where,
      }: {
        where: { tenantId_moduleName_key: { tenantId: string; key: string } };
      }) => {
        const f = tenants[where.tenantId_moduleName_key.tenantId];
        if (where.tenantId_moduleName_key.key !== 'public-home') return null;
        return f?.publicHome === undefined ? null : { valueJson: f.publicHome };
      },
    },
    modThemingTenantTheme: {
      findUnique: async ({ where }: { where: { tenantId: string } }) =>
        t(where.tenantId).theme ?? null,
    },
    tenantDomain: {
      findFirst: async ({ where }: { where: { tenantId: string } }) => {
        const h = t(where.tenantId).host;
        return h ? { hostname: h } : null;
      },
    },
    user: {
      count: async ({ where }: { where: { tenantId: string; NOT?: unknown } }) => {
        const f = t(where.tenantId);
        return where.NOT ? f.students : f.students + f.staff;
      },
      findFirst: async ({
        where,
      }: {
        where: { tenantId: string; roles: { some: { role: { name: string } } } };
      }) => {
        const f = t(where.tenantId);
        if (where.roles.some.role.name !== 'tenant_admin') return null;
        return f.creator ?? null;
      },
    },
    modZoomSession: {
      findMany: async ({ where }: { where: { tenantId: string } }) =>
        (t(where.tenantId).sessions ?? [])
          .filter((s) => ['SCHEDULED', 'STARTED'].includes(s.status))
          .map(({ topic, startTime, durationMinutes }) => ({ topic, startTime, durationMinutes })),
    },
    modCoursesCourse: {
      findMany: async ({ where }: { where: { tenantId: string; id?: { in: string[] } } }) =>
        (t(where.tenantId).courses ?? [])
          .filter((c) => c.published !== false)
          .filter((c) => !where.id || where.id.in.includes(c.id))
          .map((c) => ({
            id: c.id,
            slug: c.slug,
            title: c.title,
            description: c.description ?? null,
            thumbnailUrl: null,
            estimatedMinutes: null,
          })),
    },
    // Lo que mira el comprobador de «¿se vende?» para la opción gratuita.
    modBillingProduct: {
      findFirst: async ({ where }: { where: { tenantId: string; courseId: string } }) =>
        (t(where.tenantId).courses ?? []).find((c) => c.id === where.courseId && c.price)
          ? { id: 'p' }
          : null,
    },
    modSubscriptionsSubscription: { findFirst: async () => null },
    modAccessGroup: { findMany: async () => [] },
    modSubscriptionsMembershipConfig: { findUnique: async () => null },
    modPaymentConnectionsTier: { findMany: async () => [] },
  };
  const registry = {
    getBillingService: () => ({
      getCatalog: async (tenantId: string) => {
        calls.catalog += 1;
        return (t(tenantId).courses ?? [])
          .filter((c) => c.price)
          .map((c) => ({
            courseId: c.id,
            options: [
              {
                id: `o-${c.id}`,
                name: '',
                perks: [],
                unitAmount: c.price!,
                compareAtAmount: null,
                currency: 'eur',
                discountPercent: null,
                isFeatured: false,
              },
            ],
          }));
      },
    }),
    getMembershipService: () => ({
      getPublicPage: async (tenantId: string) => {
        const m = t(tenantId).membership;
        if (!m || m === 'inactive') throw new MembershipPageInactiveError();
        return {
          headline: m.headline ?? 'Hazte miembro',
          subheadline: null,
          plans: Array.from({ length: m.plans }, (_, i) => ({
            id: `plan-${i}`,
            name: `Plan ${i}`,
            intervalMonths: 1,
            amountCents: 1900 + i,
            currency: 'eur',
            compareAtCents: null,
            trialDays: 7,
            isFeatured: false,
          })),
          courses: [],
        };
      },
    }),
  };
  const tenantModules = {
    list: async (tenantId: string) =>
      (t(tenantId).modules ?? ALL_MODULES).map((name) => ({ name, enabled: true })),
  };
  const tenantConfig = {
    get: async (tenantId: string, scope: string, key: string) =>
      scope === 'member-registration' && key === 'verification' && t(tenantId).registration
        ? { enabled: true, verifiers: [] }
        : undefined,
  };
  return { prisma, registry, tenantModules, tenantConfig, calls };
}

function service(w: ReturnType<typeof world>, gate?: unknown) {
  return new AcademyHomeService(
    w.prisma as never,
    w.registry as never,
    w.tenantModules as never,
    w.tenantConfig as never,
    gate as never,
  );
}

const A: TenantFixture = {
  name: 'Morning Pour',
  simpleMode: true,
  host: 'morningpour.example.com',
  theme: {
    logoUrl: '/logo-a.png',
    logoDisplayMode: 'logo_and_name',
    about: 'Café en casa',
    coverUrl: '/cover-a.jpg',
    socialLinks: [{ kind: 'instagram', url: 'https://instagram.com/a' }],
    brandHue: 14,
    brandSaturation: 72,
  },
  students: 10,
  staff: 1,
  creator: { name: 'Hannah Brooks', avatarUrl: '/hannah.png' },
  sessions: [
    {
      topic: 'Q&A',
      startTime: new Date(Date.now() + 86_400_000),
      durationMinutes: 60,
      status: 'SCHEDULED',
    },
  ],
  courses: [
    {
      id: 'a1',
      slug: 'latte',
      title: 'Latte',
      description: '<p>Leche <b>perfecta</b></p>',
      price: 4900,
    },
    { id: 'a2', slug: 'gratis-a', title: 'Gratis A' },
  ],
  membership: { plans: 2, headline: 'Únete al club' },
  registration: true,
};

const B: TenantFixture = {
  name: 'Primer Sorbo',
  simpleMode: true,
  theme: { about: 'Sorbo B' },
  students: 0,
  staff: 1,
  creator: { name: 'ana@correo.test', avatarUrl: null },
  courses: [{ id: 'b1', slug: 'espresso-b', title: 'Espresso B', price: 2900 }],
  membership: 'inactive',
};

describe('AcademyHomeService — datos publicables del aula', () => {
  it('compone la portada con lo real del aula', async () => {
    const w = world({ a: A });
    const data = await service(w).get('a');
    expect(data.academy).toMatchObject({
      name: 'Morning Pour',
      coverUrl: '/cover-a.jpg',
      description: 'Café en casa',
      host: 'morningpour.example.com',
      brandHue: 14,
    });
    expect(data.members).toBe(11);
    expect(data.creator).toEqual({ name: 'Hannah Brooks', avatarUrl: '/hannah.png' });
    expect(data.nextLive).toMatchObject({ title: 'Q&A', durationMinutes: 60 });
    expect(data.offers.courses).toEqual([
      expect.objectContaining({
        slug: 'latte',
        excerpt: 'Leche perfecta',
        price: { amountCents: 4900, currency: 'eur', compareAtCents: null, discountPercent: null },
      }),
    ]);
    expect(data.offers.membership).toMatchObject({
      headline: 'Únete al club',
      plan: { amountCents: 1900, intervalMonths: 1, trialDays: 7 },
      planCount: 2,
    });
    // El curso sin precio es de cualquier miembro; el que se vende, no.
    expect(data.offers.free).toEqual({
      courses: [{ slug: 'gratis-a', title: 'Gratis A', thumbnailUrl: null }],
    });
  });

  it('nada de alumnos: ni caras, ni nombres, ni correos; y nunca el enlace de la sala', async () => {
    const w = world({ a: A });
    const json = JSON.stringify(await service(w).get('a'));
    expect(json).not.toContain('faces');
    expect(json).not.toMatch(/joinUrl|startUrl|@/);
  });

  it('sin alumnos no presume de miembros, y un nombre que es un correo no se enseña', async () => {
    const w = world({ b: B });
    const data = await service(w).get('b');
    expect(data.members).toBeNull();
    expect(data.creator).toBeNull();
    // Membresía apagada: no es una opción. Sin solicitudes de alta: no hay gratis.
    expect(data.offers.membership).toBeNull();
    expect(data.offers.free).toBeNull();
    expect(data.nextLive).toBeNull();
  });

  it('el titular por defecto de la membresía (en español) no se enseña', async () => {
    const w = world({ a: { ...A, membership: { plans: 1 } } });
    expect((await service(w).get('a')).offers.membership?.headline).toBeNull();
  });

  it('un directo que ya terminó no es «el próximo»', async () => {
    const pasado = {
      topic: 'Ya fue',
      startTime: new Date(Date.now() - 3 * 3_600_000),
      durationMinutes: 60,
      status: 'SCHEDULED',
    };
    const w = world({ a: { ...A, sessions: [pasado] } });
    expect((await service(w).get('a')).nextLive).toBeNull();
  });

  it('con las altas congeladas no se ofrece nada', async () => {
    const w = world({ a: { ...A, frozen: true } });
    const { offers } = await service(w).get('a');
    expect(offers).toEqual({ courses: [], coursesTotal: 0, membership: null, free: null });
  });

  it('si la cuenta de cobros no puede vender, nada a la venta (el acceso gratis sigue)', async () => {
    const w = world({ a: A });
    const gate = {
      publicCheckoutInfo: async () => ({
        blockedReason: 'not_connected',
        platform: true,
        settlementCurrency: null,
      }),
    };
    const { offers } = await service(w, gate).get('a');
    expect(offers.courses).toEqual([]);
    expect(offers.membership).toBeNull();
    expect(offers.free?.courses).toHaveLength(1);
  });

  it('un módulo apagado en el aula no aporta nada', async () => {
    const w = world({ a: { ...A, modules: [] } });
    const data = await service(w).get('a');
    expect(data.offers.courses).toEqual([]);
    expect(data.offers.membership).toBeNull();
    expect(data.offers.free).toBeNull();
    expect(data.nextLive).toBeNull();
  });

  it(`enseña como mucho ${ACADEMY_HOME_MAX_COURSES} cursos y dice cuántos hay`, async () => {
    const courses = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      slug: `c${i}`,
      title: `C${i}`,
      price: 1000 + i,
    }));
    const w = world({ a: { ...A, courses } });
    const { offers } = await service(w).get('a');
    expect(offers.courses).toHaveLength(ACADEMY_HOME_MAX_COURSES);
    expect(offers.coursesTotal).toBe(8);
  });
});

describe('AcademyHomeService — caché por aula', () => {
  it('lo de un aula nunca se sirve en otra, y caduca', async () => {
    const w = world({ a: A, b: B });
    const s = service(w);
    let now = 1_000_000;
    s.clock = () => now;
    const a1 = await s.get('a');
    const b1 = await s.get('b');
    expect(a1.academy.name).toBe('Morning Pour');
    expect(b1.academy.name).toBe('Primer Sorbo');
    expect(b1.offers.courses.map((c) => c.slug)).toEqual(['espresso-b']);
    expect(a1.offers.courses.map((c) => c.slug)).toEqual(['latte']);
    expect(w.calls.catalog).toBe(2);

    // Dentro de la vida de la caché: no se vuelve a leer el catálogo…
    await s.get('a');
    await s.get('b');
    expect(w.calls.catalog).toBe(2);
    // …y al caducar, sí.
    now += ACADEMY_HOME_CACHE_TTL_MS + 1;
    await s.get('a');
    expect(w.calls.catalog).toBe(3);
  });

  it('la marca se lee en vivo aunque lo demás esté en caché', async () => {
    const fa: TenantFixture = { ...A, theme: { ...A.theme, about: 'Antes' } };
    const w = world({ a: fa });
    const s = service(w);
    expect((await s.get('a')).academy.description).toBe('Antes');
    fa.theme = { ...fa.theme, about: 'Después' };
    expect((await s.get('a')).academy.description).toBe('Después');
  });
});

describe('Ajuste «Página pública de la academia»', () => {
  it('lee el valor guardado y, sin él, sigue al modo del aula', async () => {
    expect(parsePublicHomeSetting({ enabled: false })).toBe(false);
    expect(parsePublicHomeSetting(true)).toBe(true);
    expect(parsePublicHomeSetting('si')).toBeNull();
    expect(defaultPublicHome(true)).toBe(true);
    expect(defaultPublicHome(false)).toBe(false);
    const w = world({ s: { ...B, simpleMode: true }, c: { ...B, simpleMode: false } });
    expect(await resolvePublicHome(w.prisma as never, 's')).toEqual({
      enabled: true,
      source: 'default',
    });
    expect(await resolvePublicHome(w.prisma as never, 'c')).toEqual({
      enabled: false,
      source: 'default',
    });
  });

  it('ante un fallo de lectura, la entrada de siempre (apagada)', async () => {
    const roto = {
      tenantSetting: {
        findUnique: async () => {
          throw new Error('caída');
        },
      },
      tenant: { findUnique: async () => ({ simpleMode: true }) },
    };
    expect(await resolvePublicHome(roto as never, 'x')).toEqual({
      enabled: false,
      source: 'default',
    });
  });
});

describe('AcademyHomeController — el aula sale del dominio', () => {
  function controller(tenants: Record<string, TenantFixture>, hosts: Record<string, string>) {
    const w = world(tenants);
    const resolver = {
      resolveByHost: async (host: string | undefined) => {
        const id = host ? hosts[host.split(':')[0]!] : undefined;
        return id ? { id, slug: id, name: tenants[id]!.name } : null;
      },
    };
    return new AcademyHomeController(resolver as never, w.prisma as never, service(w));
  }
  const req = (headers: Record<string, string>, query: Record<string, string> = {}) =>
    ({ headers, query, url: '/api/v1/public/academy-home' }) as never;

  it('cada dominio ve su aula, aunque se pida otra por parámetro', async () => {
    const ctl = controller(
      { a: A, b: B },
      { 'morningpour.example.com': 'a', 'primersorbo.example.com': 'b' },
    );
    const a = await ctl.academyHome(req({ host: 'morningpour.example.com' }, { tenant: 'b' }));
    expect(a).toMatchObject({ enabled: true, academy: { name: 'Morning Pour' } });
    const b = await ctl.academyHome(
      req({ host: 'localhost:4000', 'x-forwarded-host': 'primersorbo.example.com' }),
    );
    expect(b).toMatchObject({ enabled: true, academy: { name: 'Primer Sorbo' } });
    expect(JSON.stringify(b)).not.toContain('Morning Pour');
  });

  it('un dominio que no es de nadie: 404 sin pistas', async () => {
    const ctl = controller({ a: A }, { 'morningpour.example.com': 'a' });
    await expect(ctl.academyHome(req({ host: 'nadie.example.com' }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('con el ajuste apagado no sale ningún dato del aula', async () => {
    const ctl = controller(
      { a: { ...A, publicHome: { enabled: false } }, c: { ...A, simpleMode: false } },
      { 'a.example.com': 'a', 'c.example.com': 'c' },
    );
    expect(await ctl.academyHome(req({ host: 'a.example.com' }))).toEqual({ enabled: false });
    // Aula del modo completo sin ajuste: apagada por defecto.
    expect(await ctl.academyHome(req({ host: 'c.example.com' }))).toEqual({ enabled: false });
  });
});
