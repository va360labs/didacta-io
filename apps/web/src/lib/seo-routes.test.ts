/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicSeo } from './seo';

/**
 * `robots.txt` y `sitemap.xml` POR AULA, con la API doblada en `fetch` (que es
 * la frontera real: el web no sabe de aulas más que lo que le contesta
 * `GET /api/v1/public/seo` para el host que le pasa).
 *
 * Lo que no puede pasar: que un aula vea el robots o el sitemap de otra (la
 * caché del servidor es por host), que una caída de la API se convierta en un
 * «indexa todo» o en un «no indexes nada» guardado un día, y que un aula con la
 * portada apagada publique algo.
 */

const AULA_A = 'morningpour.example.com';
const AULA_B = 'primersorbo.example.com';
const APAGADA = 'completa.example.com';
const CAIDA = 'caida.example.com';

const answers: Record<string, PublicSeo | 'down' | 404> = {
  [AULA_A]: {
    indexable: true,
    canonicalHost: AULA_A,
    locale: 'en',
    academy: { name: 'Morning Pour', description: null, logoUrl: null, coverUrl: null, sameAs: [] },
    home: { lastmod: '2026-05-01T00:00:00.000Z' },
    courses: [{ slug: 'latte-art', lastmod: '2026-05-01T00:00:00.000Z' }],
  },
  [AULA_B]: {
    indexable: true,
    // Sin dominio canónico publicable: el de la petición.
    canonicalHost: null,
    locale: 'pt',
    academy: { name: 'Primer Sorbo', description: null, logoUrl: null, coverUrl: null, sameAs: [] },
    home: { lastmod: '2026-01-20T00:00:00.000Z' },
    courses: [{ slug: 'cata', lastmod: '2026-01-20T00:00:00.000Z' }],
  },
  [APAGADA]: { indexable: false },
  [CAIDA]: 'down',
};

let seoCalls: string[];

beforeEach(() => {
  seoCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      if (!url.endsWith('/api/v1/public/seo')) throw new Error(`fetch inesperado: ${url}`);
      const host = init?.headers?.['x-forwarded-host'] ?? '';
      seoCalls.push(host);
      const answer = answers[host] ?? 404;
      if (answer === 'down') throw new Error('ECONNREFUSED');
      if (answer === 404) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Módulos recién cargados: la caché por host vive en el módulo. */
async function routes() {
  vi.resetModules();
  const robots = await import('@/app/robots.txt/route');
  const sitemap = await import('@/app/sitemap.xml/route');
  return { robots: robots.GET, sitemap: sitemap.GET };
}

function req(host: string, path: string, proto = 'https'): Request {
  return new Request(`http://localhost:3010${path}`, {
    headers: { host: 'localhost:3010', 'x-forwarded-host': host, 'x-forwarded-proto': proto },
  });
}

describe('robots.txt por aula', () => {
  it('cada dominio, el suyo: allowlist y sitemap de su aula', async () => {
    const { robots } = await routes();
    const a = await robots(req(AULA_A, '/robots.txt'));
    const b = await robots(req(AULA_B, '/robots.txt'));
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(a.headers.get('cache-control')).toBe('public, max-age=300');
    const ta = await a.text();
    const tb = await b.text();
    expect(ta).toContain('Allow: /$');
    expect(ta).toContain(`Sitemap: https://${AULA_A}/sitemap.xml`);
    expect(ta).not.toContain(AULA_B);
    expect(tb).toContain(`Sitemap: https://${AULA_B}/sitemap.xml`);
    expect(tb).not.toContain(AULA_A);
  });

  it('desde un dominio secundario del aula, el sitemap apunta al canónico', async () => {
    answers['secundario.example.com'] = answers[AULA_A]!;
    const { robots } = await routes();
    const txt = await (await robots(req('secundario.example.com', '/robots.txt'))).text();
    expect(txt).toContain(`Sitemap: https://${AULA_A}/sitemap.xml`);
  });

  it('portada apagada o dominio sin aula: Disallow: / entero', async () => {
    const { robots } = await routes();
    for (const host of [APAGADA, 'nadie.example.com']) {
      const res = await robots(req(host, '/robots.txt'));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
    }
  });

  it('API caída: 503 sin caché (el buscador vuelve luego), nunca un Allow ni un Disallow', async () => {
    const { robots } = await routes();
    const res = await robots(req(CAIDA, '/robots.txt'));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('retry-after')).toBe('120');
    expect(await res.text()).not.toMatch(/Allow|Disallow/);
  });
});

describe('sitemap.xml por aula', () => {
  it('solo las URL de su aula, con su dominio y su lastmod', async () => {
    const { sitemap } = await routes();
    const a = await sitemap(req(AULA_A, '/sitemap.xml'));
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const xa = await a.text();
    expect(xa).toContain(`<loc>https://${AULA_A}/</loc>`);
    expect(xa).toContain(`<loc>https://${AULA_A}/catalog/latte-art</loc>`);
    expect(xa).not.toContain('/catalog/cata<');

    const xb = await (await sitemap(req(AULA_B, '/sitemap.xml', 'http'))).text();
    expect(xb).toContain(`<loc>http://${AULA_B}/catalog/cata</loc>`);
    expect(xb).not.toContain('latte-art');
    expect(xb).not.toContain(AULA_A);
  });

  it('caché por host: la segunda petición de un aula no vuelve a la API, y la de otra sí', async () => {
    const { sitemap } = await routes();
    await sitemap(req(AULA_A, '/sitemap.xml'));
    await sitemap(req(AULA_A, '/sitemap.xml'));
    await sitemap(req(AULA_B, '/sitemap.xml'));
    expect(seoCalls).toEqual([AULA_A, AULA_B]);
  });

  it('portada apagada: 404; API caída: 503', async () => {
    const { sitemap } = await routes();
    expect((await sitemap(req(APAGADA, '/sitemap.xml'))).status).toBe(404);
    expect((await sitemap(req(CAIDA, '/sitemap.xml'))).status).toBe(503);
  });
});
