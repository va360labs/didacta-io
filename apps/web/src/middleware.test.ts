import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en/common.json';
import es from '@/i18n/messages/es/common.json';
import { pickSuspendedCatalog } from '@/lib/tenant-suspended-page';

/**
 * Host gate del middleware, con el tercer caso: el aula SUSPENDIDA.
 *
 * Antes solo había dos respuestas: el host es de un tenant (se sirve) o no lo
 * es (404). Un tenant suspendido caía en la segunda, así que el cliente con la
 * suscripción vencida veía «Not Found» en su propio dominio.
 *
 * La API se dobla por `fetch`, que es exactamente la frontera real: el
 * middleware no sabe nada de tenants salvo lo que le contesta
 * `/api/v1/tenancy/resolve`.
 */

type Resolve = { known?: boolean; slug?: string | null; surface?: string | null } & Record<
  string,
  unknown
>;

/** Lo que contesta la API por host. Un host que no esté aquí no es de nadie. */
let hosts: Record<string, Resolve | 'down' | 'http-500'>;
let resolveCalls: string[];

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      if (url.endsWith('/api/v1/setup/status')) {
        return new Response(JSON.stringify({ initialized: true }), { status: 200 });
      }
      if (url.endsWith('/api/v1/tenancy/resolve')) {
        const host = init?.headers?.['x-forwarded-host'] ?? '';
        resolveCalls.push(host);
        const answer = hosts[host] ?? { known: false, slug: null, surface: null };
        if (answer === 'down') throw new Error('ECONNREFUSED');
        if (answer === 'http-500') return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ host, ...answer }), { status: 200 });
      }
      throw new Error(`fetch inesperado: ${url}`);
    }),
  );
}

/** Módulo recién cargado en cada test: sus cachés viven en el módulo. */
async function loadMiddleware() {
  vi.resetModules();
  return (await import('./middleware')).middleware;
}

function request(
  host: string,
  path = '/',
  extra: { cookie?: string; acceptLanguage?: string } = {},
): NextRequest {
  const headers = new Headers({ host: 'localhost:3000', 'x-forwarded-host': host });
  if (extra.cookie) headers.set('cookie', extra.cookie);
  if (extra.acceptLanguage) headers.set('accept-language', extra.acceptLanguage);
  return new NextRequest(`https://${host}${path}`, { headers });
}

/** `NextResponse.next()` se reconoce por esta cabecera interna de Next. */
const pasa = (res: Response) => res.headers.get('x-middleware-next') === '1';

const ACTIVA = 'aula-activa.didacta.io';
const SUSPENDIDA = 'aula-impagada.didacta.io';
const LIBRE = 'zzz-random.didacta.io';

beforeEach(() => {
  resolveCalls = [];
  hosts = {
    [ACTIVA]: { known: true, slug: 'aula-activa', surface: 'APP', suspended: false },
    [SUSPENDIDA]: { known: false, slug: null, surface: null, suspended: true },
  };
  stubApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('middleware · host gate', () => {
  it('control: un aula en marcha se sirve', async () => {
    const middleware = await loadMiddleware();
    const res = await middleware(request(ACTIVA, '/signin'));
    expect(pasa(res)).toBe(true);
    expect(res.status).toBe(200);
  });

  it('control: un host que no es de nadie sigue dando el 404 pelado de siempre', async () => {
    const middleware = await loadMiddleware();
    const res = await middleware(request(LIBRE));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('Not Found');
  });

  it('un aula SUSPENDIDA no es un 404 ni un 200: 503 con su página', async () => {
    const middleware = await loadMiddleware();
    const res = await middleware(request(SUSPENDIDA));

    expect(res.status).toBe(503);
    expect(pasa(res)).toBe(false);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    const html = await res.text();
    expect(html).toContain(es.tenantSuspended.title);
    expect(html).toContain(es.tenantSuspended.owner);
    expect(html).not.toBe('Not Found');
  });

  it.each(['/', '/signin', '/signup', '/forgot-password', '/courses', '/admin/users'])(
    'en un aula suspendida %s tampoco sirve la app: no hay login que intentar',
    async (path) => {
      const middleware = await loadMiddleware();
      const res = await middleware(request(SUSPENDIDA, path));
      expect(res.status).toBe(503);
      expect(pasa(res)).toBe(false);
      const html = await res.text();
      expect(html).not.toMatch(/<form|<input|<script|<a /i);
    },
  );

  it('no revela nada del tenant, ni aunque la API lo mandase por error', async () => {
    hosts[SUSPENDIDA] = {
      known: false,
      suspended: true,
      slug: 'academia-secreta',
      name: 'Academia Secreta S.L.',
      tenantId: 'tenant-9f3c',
      surface: 'APP',
    };
    const middleware = await loadMiddleware();
    const html = await (await middleware(request(SUSPENDIDA))).text();

    expect(html).not.toMatch(/academia-secreta|Academia Secreta|tenant-9f3c/);
    // Ni el propio hostname: la página no lleva nada de quien la pide.
    expect(html).not.toContain(SUSPENDIDA);
    expect(html).not.toMatch(/didacta/i);
  });

  describe('idioma de la página', () => {
    it('sin cookie ni Accept-Language → español', async () => {
      const middleware = await loadMiddleware();
      const res = await middleware(request(SUSPENDIDA));
      expect(res.headers.get('content-language')).toBe('es');
      expect(await res.text()).toContain('<html lang="es">');
    });

    it('con la cookie de idioma de la app en inglés → inglés', async () => {
      const middleware = await loadMiddleware();
      const res = await middleware(request(SUSPENDIDA, '/', { cookie: 'didacta_locale=en-US' }));
      const html = await res.text();
      expect(res.status).toBe(503);
      expect(res.headers.get('content-language')).toBe('en');
      expect(html).toContain(en.tenantSuspended.title);
      expect(html).toContain(en.tenantSuspended.owner);
      expect(html).not.toContain(es.tenantSuspended.title);
    });

    it('sin cookie, con Accept-Language inglés → inglés', async () => {
      const middleware = await loadMiddleware();
      const res = await middleware(
        request(SUSPENDIDA, '/', { acceptLanguage: 'en-GB,en;q=0.9,es;q=0.5' }),
      );
      expect(await res.text()).toContain(en.tenantSuspended.title);
    });

    it('la cookie manda sobre Accept-Language', async () => {
      const middleware = await loadMiddleware();
      const res = await middleware(
        request(SUSPENDIDA, '/', { cookie: 'didacta_locale=es-ES', acceptLanguage: 'en-US' }),
      );
      expect(await res.text()).toContain(es.tenantSuspended.title);
    });
  });

  describe('lo que NO puede convertirse en un aviso de suspensión', () => {
    it('una API anterior a `suspended` (no manda el campo) → el 404 de antes', async () => {
      hosts[SUSPENDIDA] = { known: false, slug: null, surface: null };
      const middleware = await loadMiddleware();
      const res = await middleware(request(SUSPENDIDA));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Not Found');
    });

    it('`suspended` que no es un true explícito → no cuenta', async () => {
      hosts[SUSPENDIDA] = { known: false, suspended: 'true' };
      const middleware = await loadMiddleware();
      expect((await middleware(request(SUSPENDIDA))).status).toBe(404);
    });

    it('si la API da el host por conocido, se sirve aunque diga `suspended`', async () => {
      hosts[ACTIVA] = { known: true, surface: 'APP', suspended: true };
      const middleware = await loadMiddleware();
      expect(pasa(await middleware(request(ACTIVA)))).toBe(true);
    });

    it.each(['down', 'http-500'] as const)(
      'API caída (%s) → se deja pasar, como antes: nunca un aviso por un fallo',
      async (fallo) => {
        hosts[SUSPENDIDA] = fallo;
        const middleware = await loadMiddleware();
        expect(pasa(await middleware(request(SUSPENDIDA)))).toBe(true);
      },
    );

    it('localhost y las IP no se gatean', async () => {
      const middleware = await loadMiddleware();
      expect(pasa(await middleware(request('localhost:3000')))).toBe(true);
      expect(pasa(await middleware(request('203.0.113.7:3000')))).toBe(true);
      expect(resolveCalls).toEqual([]);
    });
  });

  it('el aviso caduca en 30 s: al reactivarse el aula, se sirve sin esperar cinco minutos', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-10T10:00:00Z'));
    const middleware = await loadMiddleware();

    expect((await middleware(request(SUSPENDIDA))).status).toBe(503);
    // Dentro de la ventana no se vuelve a preguntar a la API.
    expect((await middleware(request(SUSPENDIDA, '/signin'))).status).toBe(503);
    expect(resolveCalls).toEqual([SUSPENDIDA]);

    // El cliente regulariza su suscripción.
    hosts[SUSPENDIDA] = { known: true, slug: 'aula-impagada', surface: 'APP', suspended: false };
    vi.setSystemTime(new Date('2026-01-10T10:00:31Z'));

    expect(pasa(await middleware(request(SUSPENDIDA)))).toBe(true);
    expect(resolveCalls).toEqual([SUSPENDIDA, SUSPENDIDA]);
  });
});

describe('pickSuspendedCatalog', () => {
  it.each([
    [null, null, 'es'],
    ['en-US', null, 'en'],
    ['es-AR', 'en-US', 'es'],
    [null, 'en', 'en'],
    [null, 'fr-FR,en;q=0.8', 'en'],
    [null, 'en;q=0.2,es;q=0.9', 'es'],
    [null, 'en;q=0,es;q=0.1', 'es'],
    [null, 'fr-FR,de;q=0.8', 'es'],
    ['pt-BR', 'en', 'pt'],
    [null, 'pt-BR,pt;q=0.9,en;q=0.8', 'pt'],
    ['fr-FR', 'en', 'es'],
  ] as const)('cookie=%s, Accept-Language=%s → %s', (cookie, accept, expected) => {
    expect(pickSuspendedCatalog(cookie, accept)).toBe(expected);
  });
});

describe('middleware · rutas viejas en español → 308 a la nueva', () => {
  const SITIO = 'www.aula-activa.test';
  beforeEach(() => {
    hosts[SITIO] = { known: true, slug: 'aula-activa', surface: 'SITE', suspended: false };
  });

  it('el enlace de venta compartido conserva el slug y el ?ref=', async () => {
    const mw = await loadMiddleware();
    const res = await mw(request(ACTIVA, '/catalogo/acuarela?ref=ANA&utm_source=ig'));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(
      `https://${ACTIVA}/catalog/acuarela?ref=ANA&utm_source=ig`,
    );
  });

  it('la vuelta de Stripe de un pago en curso llega a la nueva con su session_id', async () => {
    const mw = await loadMiddleware();
    const res = await mw(request(ACTIVA, '/cursos/checkout/success?session_id=cs_test_123'));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(
      `https://${ACTIVA}/courses/checkout/success?session_id=cs_test_123`,
    );
  });

  it('segmento español debajo de uno dinámico: /formador/cursos/<id>/alumnos/<m>', async () => {
    const mw = await loadMiddleware();
    const res = await mw(request(ACTIVA, '/formador/cursos/c-1/alumnos/e-9'));
    expect(res.headers.get('location')).toBe(`https://${ACTIVA}/studio/courses/c-1/students/e-9`);
  });

  it('también en localhost (el aula sin dominio de un self-host)', async () => {
    const mw = await loadMiddleware();
    const res = await mw(
      new NextRequest('http://localhost:3000/verificar/abc', {
        headers: new Headers({ host: 'localhost:3000' }),
      }),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('http://localhost:3000/verify/abc');
  });

  it('control: la ruta nueva se sirve sin redirección', async () => {
    const mw = await loadMiddleware();
    const res = await mw(request(ACTIVA, '/catalog/acuarela?ref=ANA'));
    expect(pasa(res)).toBe(true);
    expect(res.headers.get('location')).toBeNull();
  });

  it('en el dominio del SITIO público no se redirige: /cursos puede ser una página suya', async () => {
    const mw = await loadMiddleware();
    const res = await mw(request(SITIO, '/cursos'));
    expect(res.status).not.toBe(308);
    expect(res.headers.get('x-middleware-rewrite')).toBe(`https://${SITIO}/site/cursos`);
  });

  it('un host que no es de nadie sigue en 404, sin redirigir', async () => {
    const mw = await loadMiddleware();
    const res = await mw(request(LIBRE, '/catalogo/x'));
    expect(res.status).toBe(404);
  });
});

describe('middleware · noindex por cabecera (solo la portada y la venta se indexan)', () => {
  const SITIO = 'www.aula-activa.test';
  beforeEach(() => {
    hosts[SITIO] = { known: true, slug: 'aula-activa', surface: 'SITE', suspended: false };
  });

  it.each([
    '/signin',
    '/join?ref=ANA',
    '/member-registration',
    '/home',
    '/community',
    '/courses/acuarela',
    '/admin/settings',
    '/studio',
    '/catalog/checkout/success?session_id=cs_1',
  ])('%s lleva X-Robots-Tag: noindex, nofollow', async (path) => {
    const mw = await loadMiddleware();
    const res = await mw(request(ACTIVA, path));
    expect(pasa(res)).toBe(true);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it.each([
    '/',
    '/?ref=ANA',
    '/catalog',
    '/catalog/acuarela?ref=ANA',
    '/robots.txt',
    '/sitemap.xml',
  ])('%s no la lleva (lo decide la página con los datos del aula)', async (path) => {
    const mw = await loadMiddleware();
    const res = await mw(request(ACTIVA, path));
    expect(pasa(res)).toBe(true);
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  it('también en localhost (un self-host sin dominio)', async () => {
    const mw = await loadMiddleware();
    const res = await mw(
      new NextRequest('http://localhost:3000/admin', {
        headers: new Headers({ host: 'localhost:3000' }),
      }),
    );
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('el SITIO público no se toca: sus reglas son las suyas', async () => {
    const mw = await loadMiddleware();
    const res = await mw(request(SITIO, '/blog'));
    expect(res.headers.get('x-middleware-rewrite')).toBe(`https://${SITIO}/site/blog`);
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });
});

describe('textos de aula suspendida', () => {
  it('están en los dos idiomas y no son el mismo texto', () => {
    for (const key of ['metaTitle', 'title', 'body', 'owner'] as const) {
      expect(es.tenantSuspended[key].trim()).not.toBe('');
      expect(en.tenantSuspended[key].trim()).not.toBe('');
      expect(en.tenantSuspended[key]).not.toBe(es.tenantSuspended[key]);
    }
  });
});
