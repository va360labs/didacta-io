import { describe, expect, it } from 'vitest';
import { routes } from '../../src/index.js';

/// Regresión: el migrador es destructivo (importa miles de filas). Ningún
/// endpoint de jobs/preflight/cancel/report debe poder ser invocado por un
/// usuario que no sea super_admin o tenant_admin. El frontend gatea el
/// render del wizard, pero estos tests blindan el backend como última
/// línea de defensa: si alguien quita el `requireAdmin`, el test falla.
///
/// Contexto: en alpha.46 la page del wizard vivía fuera del route group
/// `(app)`, lo que dejaba la UI accesible sin login. Los handlers tampoco
/// chequeaban rol — solo `requireUser` — así que cualquier alumno
/// autenticado podía dispararlos. Este test fija el contrato corregido.

type AnyHandler = (typeof routes)[number]['handler'];

function buildReq(
  user: { sub: string; tenantId: string; roles: string[] } | null,
  body: unknown = {},
) {
  return {
    method: 'POST' as const,
    path: '/preflight',
    params: {} as Record<string, string>,
    query: {} as Record<string, string | string[]>,
    body,
    user,
  };
}

const PROTECTED_PATHS = [
  'POST /preflight',
  'POST /jobs',
  'GET /jobs',
  'GET /jobs/:id',
  'POST /jobs/:id/cancel',
  'GET /jobs/:id/report',
];

describe('migrator-learndash · role gate', () => {
  for (const key of PROTECTED_PATHS) {
    it(`${key} responde 401 sin sesión`, async () => {
      const [method, path] = key.split(' ');
      const route = routes.find((r) => r.method === method && r.path === path);
      expect(route, `ruta ${key} no encontrada`).toBeDefined();
      const handler = route!.handler as AnyHandler;
      const res = await handler({ ...buildReq(null), method: route!.method, path: route!.path });
      expect(res.status).toBe(401);
    });

    it(`${key} responde 403 para usuario alumno autenticado`, async () => {
      const [method, path] = key.split(' ');
      const route = routes.find((r) => r.method === method && r.path === path);
      expect(route, `ruta ${key} no encontrada`).toBeDefined();
      const handler = route!.handler as AnyHandler;
      const studentUser = { sub: 'u-1', tenantId: 't-1', roles: ['alumno'] };
      const res = await handler({
        ...buildReq(studentUser),
        method: route!.method,
        path: route!.path,
      });
      expect(res.status).toBe(403);
    });

    it(`${key} responde 403 para formador (no admin)`, async () => {
      const [method, path] = key.split(' ');
      const route = routes.find((r) => r.method === method && r.path === path);
      const handler = route!.handler as AnyHandler;
      const trainerUser = { sub: 'u-2', tenantId: 't-1', roles: ['formador'] };
      const res = await handler({
        ...buildReq(trainerUser),
        method: route!.method,
        path: route!.path,
      });
      expect(res.status).toBe(403);
    });
  }

  it('GET /ping queda libre (sanity check sin auth)', async () => {
    const route = routes.find((r) => r.method === 'GET' && r.path === '/ping');
    expect(route).toBeDefined();
    const res = await route!.handler({ ...buildReq(null), method: 'GET', path: '/ping' });
    expect(res.status).toBe(200);
  });

  it('POST /preflight con tenant_admin pasa el gate (llega a validación de body)', async () => {
    const route = routes.find((r) => r.method === 'POST' && r.path === '/preflight');
    const adminUser = { sub: 'u-3', tenantId: 't-1', roles: ['tenant_admin'] };
    // Sin credentials válidas: el handler responde 400 VALIDATION_ERROR,
    // lo que prueba que el gate de rol ya pasó (no rebota en 403).
    const res = await route!.handler({
      ...buildReq(adminUser, {}),
      method: 'POST',
      path: '/preflight',
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('POST /preflight con super_admin pasa el gate y rebota 503 si falta ctx.http (host antiguo)', async () => {
    const route = routes.find((r) => r.method === 'POST' && r.path === '/preflight');
    const superAdminUser = { sub: 'u-4', tenantId: 't-0', roles: ['super_admin'] };
    const res = await route!.handler({
      ...buildReq(superAdminUser, {
        credentials: { baseUrl: 'https://wp.example', username: 'u', appPassword: 'pppppppp' },
      }),
      method: 'POST',
      path: '/preflight',
    });
    // Sin ctx.http (host alpha.48 o anterior) → 503 HTTP_NOT_AVAILABLE
    expect(res.status).toBe(503);
    expect((res.body as { code: string }).code).toBe('HTTP_NOT_AVAILABLE');
  });
});

/// Tests del flujo real con ctx.http mockeado. Verifica que el preflight
/// hace los 8 requests esperados al WP origen y devuelve conteos reales
/// leyendo X-WP-Total. Cero stubs.
describe('migrator-learndash · POST /preflight con http mockeado', () => {
  const superAdmin = { sub: 'u-1', tenantId: 't-1', roles: ['super_admin'] };
  const creds = {
    baseUrl: 'https://wp.example.com',
    username: 'admin',
    appPassword: 'app pass-1234',
  };

  function makeHttp(
    handler: (url: string) => { status: number; body?: string; headers?: Record<string, string> },
  ) {
    const make = async (url: string) => {
      const r = handler(url);
      return {
        status: r.status,
        body: r.body ?? '',
        headers: r.headers ?? {},
        bytesRead: (r.body ?? '').length,
      };
    };
    return { get: make, post: make };
  }

  it('happy path: devuelve counts reales leyendo X-WP-Total', async () => {
    const route = routes.find((r) => r.method === 'POST' && r.path === '/preflight')!;
    const calls: string[] = [];
    const http = makeHttp((url) => {
      calls.push(url);
      if (url.endsWith('/wp-json/')) {
        return {
          status: 200,
          body: JSON.stringify({ name: 'Mi WordPress' }),
          headers: { 'x-wp-version': '6.4.1' },
        };
      }
      if (url.includes('/ldlms/v1/sfwd-courses')) return { status: 200, body: '[]' };
      // wp/v2/* → totals fakeados por entidad
      const totals: Record<string, string> = {
        'sfwd-courses': '12',
        'sfwd-lessons': '56',
        'sfwd-topic': '88',
        'sfwd-quiz': '23',
        groups: '4',
        users: '120',
      };
      const cpt = url.split('/wp-json/wp/v2/')[1]?.split('?')[0];
      const total = totals[cpt ?? ''] ?? '0';
      return { status: 200, body: '[]', headers: { 'x-wp-total': total } };
    });

    const res = await route.handler({
      method: 'POST',
      path: '/preflight',
      params: {},
      query: {},
      body: { credentials: creds },
      user: superAdmin,
      http,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      ok: boolean;
      siteName: string;
      wpVersion: string;
      counts: Record<string, number>;
      capabilities: Record<string, boolean>;
      warnings: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.siteName).toBe('Mi WordPress');
    expect(body.wpVersion).toBe('6.4.1');
    expect(body.counts).toEqual({
      courses: 12,
      lessons: 56,
      topics: 88,
      quizzes: 23,
      groups: 4,
      users: 120,
    });
    expect(body.capabilities.learndashV1).toBe(true);
    expect(body.warnings).toEqual([]);
    // 8 reqs: /wp-json/ + ldlms/v1 + 6 CPT
    expect(calls).toHaveLength(8);
  });

  it('credenciales inválidas → 401 WP_AUTH_FAILED', async () => {
    const route = routes.find((r) => r.method === 'POST' && r.path === '/preflight')!;
    const http = makeHttp(() => ({ status: 401, body: '' }));
    const res = await route.handler({
      method: 'POST',
      path: '/preflight',
      params: {},
      query: {},
      body: { credentials: creds },
      user: superAdmin,
      http,
    });
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe('WP_AUTH_FAILED');
  });

  it('LearnDash REST 404 → warning LEARNDASH_REST_UNAVAILABLE pero sigue contando', async () => {
    const route = routes.find((r) => r.method === 'POST' && r.path === '/preflight')!;
    const http = makeHttp((url) => {
      if (url.endsWith('/wp-json/')) return { status: 200, body: '{}' };
      if (url.includes('/ldlms/v1/')) return { status: 404, body: '' };
      return { status: 200, body: '[]', headers: { 'x-wp-total': '5' } };
    });
    const res = await route.handler({
      method: 'POST',
      path: '/preflight',
      params: {},
      query: {},
      body: { credentials: creds },
      user: superAdmin,
      http,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      capabilities: { learndashV1: boolean };
      warnings: Array<{ code: string }>;
    };
    expect(body.capabilities.learndashV1).toBe(false);
    expect(body.warnings.some((w) => w.code === 'LEARNDASH_REST_UNAVAILABLE')).toBe(true);
  });

  it('CPT 404 → counts: unknown con warning CPT_NOT_FOUND', async () => {
    const route = routes.find((r) => r.method === 'POST' && r.path === '/preflight')!;
    const http = makeHttp((url) => {
      if (url.endsWith('/wp-json/')) return { status: 200, body: '{}' };
      if (url.includes('/ldlms/v1/')) return { status: 200, body: '[]' };
      if (url.includes('sfwd-topic')) return { status: 404, body: '' };
      return { status: 200, body: '[]', headers: { 'x-wp-total': '7' } };
    });
    const res = await route.handler({
      method: 'POST',
      path: '/preflight',
      params: {},
      query: {},
      body: { credentials: creds },
      user: superAdmin,
      http,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      counts: Record<string, number | string>;
      warnings: Array<{ code: string }>;
    };
    expect(body.counts['topics']).toBe('unknown');
    expect(body.counts['courses']).toBe(7);
    expect(body.warnings.some((w) => w.code === 'CPT_NOT_FOUND')).toBe(true);
  });
});
