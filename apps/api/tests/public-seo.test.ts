/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Indexación del aula (`GET /public/seo`), lo que el web convierte en
 * `robots.txt`, `sitemap.xml`, `noindex` y JSON-LD:
 *  - el aula sale SOLO del dominio (404 si no es de nadie; ni query ni body);
 *  - con la portada pública apagada no sale ningún dato, solo «no se indexa»;
 *  - dominio canónico: el primario VERIFICADO y publicable, o ninguno;
 *  - fichas: solo los cursos a la venta (misma regla que el catálogo), con su
 *    última modificación real (curso o precio);
 *  - caché por aula: lo de un aula nunca se sirve en otra.
 */

import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PublicSeoController } from '../src/public/public-seo.controller';
import {
  PUBLIC_SEO_CACHE_TTL_MS,
  PublicSeoService,
  type PublicSeoIndexable,
} from '../src/public/public-seo.service';

interface CourseFixture {
  id: string;
  slug: string;
  title: string;
  published?: boolean;
  /** Céntimos; sin precio, no se vende. */
  price?: number;
  updatedAt: Date;
  productUpdatedAt?: Date;
}

interface TenantFixture {
  name: string;
  simpleMode: boolean;
  publicHome?: unknown;
  locale?: string;
  frozen?: boolean;
  tenantUpdatedAt?: Date;
  theme?: Record<string, unknown> | null;
  /** Dominio primario del aula. */
  primary?: { hostname: string; isVerified: boolean };
  courses?: CourseFixture[];
  modules?: string[];
}

const d = (iso: string) => new Date(iso);

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
          updatedAt: f.tenantUpdatedAt ?? d('2026-01-01T00:00:00Z'),
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
        const f = t(where.tenantId_moduleName_key.tenantId);
        if (where.tenantId_moduleName_key.key === 'public-home') {
          return f.publicHome === undefined ? null : { valueJson: f.publicHome };
        }
        if (where.tenantId_moduleName_key.key === 'locale') {
          return f.locale ? { valueJson: f.locale } : null;
        }
        return null;
      },
    },
    user: { findMany: async () => [] },
    modThemingTenantTheme: {
      findUnique: async ({ where }: { where: { tenantId: string } }) =>
        t(where.tenantId).theme ?? null,
    },
    tenantDomain: {
      findFirst: async ({
        where,
      }: {
        where: { tenantId: string; isPrimary: boolean; isVerified?: boolean; surface?: string };
      }) => {
        const p = t(where.tenantId).primary;
        if (!p || !where.isPrimary || where.surface !== 'APP') return null;
        // Solo si la consulta exige verificado y lo está: uno sin verificar
        // NO puede acabar de canonical (no sirve tráfico).
        if (where.isVerified !== true || !p.isVerified) return null;
        return { hostname: p.hostname };
      },
    },
    modCoursesCourse: {
      findMany: async ({ where }: { where: { tenantId: string; id: { in: string[] } } }) =>
        (t(where.tenantId).courses ?? [])
          .filter((c) => c.published !== false && where.id.in.includes(c.id))
          .map((c) => ({
            id: c.id,
            slug: c.slug,
            title: c.title,
            description: null,
            thumbnailUrl: null,
            category: null,
            estimatedMinutes: null,
            updatedAt: c.updatedAt,
          })),
    },
    modBillingProduct: {
      findMany: async ({ where }: { where: { tenantId: string; courseId: { in: string[] } } }) =>
        (t(where.tenantId).courses ?? [])
          .filter((c) => c.price && where.courseId.in.includes(c.id))
          .map((c) => ({ courseId: c.id, updatedAt: c.productUpdatedAt ?? c.updatedAt })),
    },
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
  };
  const tenantModules = {
    list: async (tenantId: string) =>
      (t(tenantId).modules ?? ['mod.billing']).map((name) => ({ name, enabled: true })),
  };
  return { prisma, registry, tenantModules, calls };
}

function service(w: ReturnType<typeof world>, gate?: unknown) {
  return new PublicSeoService(
    w.prisma as never,
    w.registry as never,
    w.tenantModules as never,
    gate as never,
  );
}

const A: TenantFixture = {
  name: 'Morning Pour',
  simpleMode: true,
  locale: 'en',
  tenantUpdatedAt: d('2026-02-01T00:00:00Z'),
  primary: { hostname: 'morningpour.example.com', isVerified: true },
  theme: {
    logoUrl: '/api/v1/modules/theming/tenants/a/logo?v=1',
    about: 'Specialty coffee at home',
    signinHeadline: null,
    coverUrl: '/api/v1/modules/theming/tenants/a/cover?v=1',
    socialLinks: [
      { kind: 'instagram', url: 'https://instagram.com/morningpour' },
      { kind: 'whatsapp', url: 'https://wa.me/34600000000' },
      { kind: 'web', url: 'https://morningpour.coffee' },
    ],
    updatedAt: d('2026-03-01T00:00:00Z'),
  },
  courses: [
    {
      id: 'a1',
      slug: 'latte-art',
      title: 'Latte art',
      price: 4900,
      updatedAt: d('2026-04-01T00:00:00Z'),
      productUpdatedAt: d('2026-05-01T00:00:00Z'),
    },
    {
      id: 'a2',
      slug: 'borrador',
      title: 'Borrador',
      price: 1900,
      published: false,
      updatedAt: d('2026-06-01T00:00:00Z'),
    },
    { id: 'a3', slug: 'gratis', title: 'Gratis', updatedAt: d('2026-06-01T00:00:00Z') },
  ],
};

const B: TenantFixture = {
  name: 'Primer Sorbo',
  simpleMode: true,
  locale: 'pt',
  primary: { hostname: 'primersorbo.localhost', isVerified: true },
  theme: { about: null, signinHeadline: 'Aprende a catar', updatedAt: d('2026-01-15T00:00:00Z') },
  courses: [
    { id: 'b1', slug: 'cata', title: 'Cata', price: 2900, updatedAt: d('2026-01-20T00:00:00Z') },
  ],
};

/** Aula del modo completo sin ajuste: portada apagada por defecto. */
const COMPLETA: TenantFixture = {
  name: 'Academia Completa',
  simpleMode: false,
  primary: { hostname: 'completa.example.com', isVerified: true },
  courses: [
    { id: 'c1', slug: 'secreto', title: 'Secreto', price: 9900, updatedAt: d('2026-01-01') },
  ],
};

const indexable = (r: unknown): PublicSeoIndexable => {
  const v = r as PublicSeoIndexable;
  if (!v.indexable) throw new Error('se esperaba un aula indexable');
  return v;
};

describe('PublicSeoService', () => {
  it('portada encendida: dominio canónico, idioma, datos públicos y fichas a la venta con su lastmod', async () => {
    const r = indexable(await service(world({ a: A })).get('a'));
    expect(r.canonicalHost).toBe('morningpour.example.com');
    expect(r.locale).toBe('en');
    expect(r.academy).toEqual({
      name: 'Morning Pour',
      description: 'Specialty coffee at home',
      logoUrl: '/api/v1/modules/theming/tenants/a/logo?v=1',
      coverUrl: '/api/v1/modules/theming/tenants/a/cover?v=1',
      // WhatsApp no identifica al aula (es un teléfono o una invitación).
      sameAs: ['https://instagram.com/morningpour', 'https://morningpour.coffee'],
    });
    // Solo el curso publicado y con precio. El lastmod es el del precio (más reciente).
    expect(r.courses).toEqual([{ slug: 'latte-art', lastmod: '2026-05-01T00:00:00.000Z' }]);
    // Portada: lo último entre el aula, su marca y sus fichas.
    expect(r.home.lastmod).toBe('2026-05-01T00:00:00.000Z');
  });

  it('portada apagada (modo completo por defecto, o ajuste explícito): nada más que «no se indexa»', async () => {
    const w = world({ c: COMPLETA, b: { ...B, publicHome: { enabled: false } } });
    expect(await service(w).get('c')).toEqual({ indexable: false });
    expect(await service(w).get('b')).toEqual({ indexable: false });
    expect(w.calls.catalog).toBe(0);
  });

  it('el modo completo con la portada encendida a mano SÍ se indexa', async () => {
    const r = indexable(
      await service(world({ c: { ...COMPLETA, publicHome: { enabled: true } } })).get('c'),
    );
    expect(r.courses.map((c) => c.slug)).toEqual(['secreto']);
  });

  it('dominio canónico: sin verificar o de laboratorio (localhost) no vale; el web usa el de la petición', async () => {
    const sinVerificar = indexable(
      await service(
        world({ a: { ...A, primary: { hostname: 'aula.cliente.com', isVerified: false } } }),
      ).get('a'),
    );
    expect(sinVerificar.canonicalHost).toBeNull();
    const local = indexable(await service(world({ b: B })).get('b'));
    expect(local.canonicalHost).toBeNull();
    // La descripción cae al titular del acceso, como en la portada.
    expect(local.academy.description).toBe('Aprende a catar');
    expect(local.locale).toBe('pt');
  });

  it('sin mod.billing, con las altas congeladas o con la cuenta de cobros sin poder vender: ninguna ficha', async () => {
    const sinBilling = indexable(
      await service(world({ a: { ...A, modules: ['mod.community'] } })).get('a'),
    );
    expect(sinBilling.courses).toEqual([]);
    const congelada = indexable(await service(world({ a: { ...A, frozen: true } })).get('a'));
    expect(congelada.courses).toEqual([]);
    const gate = { publicCheckoutInfo: async () => ({ blockedReason: 'payouts_not_ready' }) };
    const bloqueada = indexable(await service(world({ a: A }), gate).get('a'));
    expect(bloqueada.courses).toEqual([]);
    // Lo demás del aula sigue indexable: la portada existe aunque no venda.
    expect(bloqueada.academy.name).toBe('Morning Pour');
  });

  it('caché por aula: lo de un aula nunca se sirve en otra, y caduca', async () => {
    const w = world({ a: A, b: B });
    const s = service(w);
    let now = 1_000_000;
    s.clock = () => now;
    const a1 = indexable(await s.get('a'));
    const b1 = indexable(await s.get('b'));
    const a2 = indexable(await s.get('a'));
    expect(a1.academy.name).toBe('Morning Pour');
    expect(b1.academy.name).toBe('Primer Sorbo');
    expect(a2).toBe(a1);
    expect(JSON.stringify(b1)).not.toContain('latte-art');
    expect(JSON.stringify(a1)).not.toContain('cata');
    expect(w.calls.catalog).toBe(2);
    now += PUBLIC_SEO_CACHE_TTL_MS + 1;
    await s.get('a');
    expect(w.calls.catalog).toBe(3);
  });
});

describe('PublicSeoController', () => {
  const req = (host: string, query: Record<string, string> = {}) =>
    ({ headers: { host: 'localhost:4000', 'x-forwarded-host': host }, query }) as never;

  function controller(hosts: Record<string, { id: string; surface?: string }>) {
    const w = world({ a: A, b: B });
    const resolver = {
      resolveByHost: async (h: string | undefined) => {
        const hit = h ? hosts[h] : undefined;
        return hit ? { id: hit.id, surface: hit.surface ?? 'APP' } : null;
      },
    };
    return new PublicSeoController(resolver as never, service(w));
  }

  it('el aula sale del dominio, nunca de la query', async () => {
    const c = controller({ 'a.example.com': { id: 'a' }, 'b.example.com': { id: 'b' } });
    const r = indexable(await c.publicSeo(req('a.example.com', { tenant: 'b' })));
    expect(r.academy.name).toBe('Morning Pour');
  });

  it('un dominio que no es de ningún aula: 404', async () => {
    const c = controller({});
    await expect(c.publicSeo(req('nadie.example.com'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el dominio de un SITIO público no es el aula: no se indexa nada de ella', async () => {
    const c = controller({ 'www.marca.com': { id: 'a', surface: 'SITE' } });
    expect(await c.publicSeo(req('www.marca.com'))).toEqual({ indexable: false });
  });
});
