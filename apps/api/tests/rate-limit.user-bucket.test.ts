/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Cubo POR USUARIO del tráfico con sesión, con el tope del aula encima.
 *
 * El defecto: toda el aula compartía un único cubo de 100/min
 * (`ratelimit:<tenant>:authenticated`). Diez alumnos navegando a la vez en
 * una clase se lo comían y el aula entera —profesor incluido— recibía 429.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { LicenseService } from '@didacta/license-sdk';
import { RateLimitInterceptor } from '../src/rate-limit/rate-limit.interceptor';
import { RateLimitService, type RateLimitRedisClient } from '../src/rate-limit/rate-limit.service';
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  resolveRateLimitConfig,
} from '../src/rate-limit/rate-limit.types';

function makeRedis(): RateLimitRedisClient & { store: Map<string, number> } {
  const store = new Map<string, number>();
  return {
    store,
    incr: vi.fn(async (key: string) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
    expire: vi.fn(async () => 1),
  };
}

async function license(state: 'community' | 'dev'): Promise<LicenseService> {
  const l = new LicenseService();
  if (state === 'dev') await l.load({ allowDevBypass: true, key: 'whatever' });
  else await l.load({ key: null });
  return l;
}

const ENV = [
  'RATE_LIMIT_COMMUNITY_USER_PER_MIN',
  'RATE_LIMIT_COMMUNITY_AUTH_PER_MIN',
  'RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN',
  'RATE_LIMIT_ENTERPRISE_USER_PER_MIN',
  'RATE_LIMIT_ENTERPRISE_AUTH_PER_MIN',
  'RATE_LIMIT_ENTERPRISE_PUBLIC_PER_MIN',
  'RATE_LIMIT_WINDOW_SECONDS',
] as const;
let backup: Record<string, string | undefined> = {};

beforeEach(() => {
  backup = {};
  for (const k of ENV) {
    backup[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

const NOW = new Date('2026-11-14T10:00:10Z');

/** `n` peticiones del usuario; devuelve cuántas pasaron. */
async function burst(service: RateLimitService, tenant: string, user: string, n: number) {
  let ok = 0;
  for (let i = 0; i < n; i += 1) {
    if ((await service.recordUserRequest(tenant, user, NOW)).allowed) ok += 1;
  }
  return ok;
}

describe('configuración', () => {
  it('sin variables, los defaults Community de siempre (100 usuario = 100 aula, 30 público)', () => {
    const c = resolveRateLimitConfig();
    expect(c.community).toEqual({ user: 100, authenticated: 100, public: 30 });
    expect(c.enterprise).toEqual(DEFAULT_RATE_LIMIT_CONFIG.enterprise);
  });

  it('sin la variable por usuario, el límite por usuario es el tope del aula (nadie queda peor)', () => {
    // La instancia que subió el tope a 100.000 por no tener cubo por usuario.
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '100000';
    expect(resolveRateLimitConfig().community.user).toBe(100_000);
  });

  it('los valores de Didacta Cloud: 600 por usuario, 12.000 por aula, 300 público', () => {
    process.env['RATE_LIMIT_COMMUNITY_USER_PER_MIN'] = '600';
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '12000';
    process.env['RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN'] = '300';
    const c = resolveRateLimitConfig();
    expect(c.community).toEqual({ user: 600, authenticated: 12000, public: 300 });
    // Con licencia, nunca por debajo: el enterprise hereda el suelo.
    expect(c.enterprise.user).toBe(1000);
    expect(c.enterprise.authenticated).toBe(12000);
    expect(c.enterprise.public).toBe(300);
  });

  it('un enterprise por usuario explícito más bajo que el community no baja el límite', () => {
    process.env['RATE_LIMIT_COMMUNITY_USER_PER_MIN'] = '500';
    process.env['RATE_LIMIT_ENTERPRISE_USER_PER_MIN'] = '50';
    expect(resolveRateLimitConfig().enterprise.user).toBe(500);
  });
});

describe('RateLimitService.recordUserRequest', () => {
  it('cada alumno tiene su cubo: diez alumnos a 60/min no se quitan cupo entre sí', async () => {
    process.env['RATE_LIMIT_COMMUNITY_USER_PER_MIN'] = '300';
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '6000';
    const service = new RateLimitService(await license('community'), makeRedis());

    for (let a = 0; a < 10; a += 1) {
      expect(await burst(service, 'aula-1', `alumno-${a}`, 60)).toBe(60);
    }
  });

  it('control: con los defaults Community (sin variables) el aula sigue topada en 100', async () => {
    const service = new RateLimitService(await license('community'), makeRedis());
    let ok = 0;
    for (let a = 0; a < 10; a += 1) ok += await burst(service, 'aula-1', `alumno-${a}`, 15);
    expect(ok).toBe(100);
  });

  it('un usuario que se pasa recibe 429 y sus compañeros siguen igual', async () => {
    process.env['RATE_LIMIT_COMMUNITY_USER_PER_MIN'] = '300';
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '6000';
    const service = new RateLimitService(await license('community'), makeRedis());

    expect(await burst(service, 'aula-1', 'desbocado', 400)).toBe(300);
    const corte = await service.recordUserRequest('aula-1', 'desbocado', NOW);
    expect(corte).toMatchObject({ allowed: false, bucket: 'user', limit: 300, remaining: 0 });
    expect(corte.retryAfterSeconds).toBe(50);

    expect((await service.recordUserRequest('aula-1', 'companera', NOW)).allowed).toBe(true);
  });

  it('lo que gasta un usuario ya cortado no cuenta para el tope del aula', async () => {
    process.env['RATE_LIMIT_COMMUNITY_USER_PER_MIN'] = '10';
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '20';
    const redis = makeRedis();
    const service = new RateLimitService(await license('community'), redis);

    await burst(service, 'aula-1', 'desbocado', 500);
    const minute = Math.floor(NOW.getTime() / 60_000);
    expect(redis.store.get(`ratelimit:aula-1:authenticated:${minute}`)).toBe(10);
    expect(await burst(service, 'aula-1', 'companera', 10)).toBe(10);
  });

  it('el tope del aula corta aunque cada usuario esté dentro de su límite', async () => {
    process.env['RATE_LIMIT_COMMUNITY_USER_PER_MIN'] = '300';
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '50';
    const service = new RateLimitService(await license('community'), makeRedis());

    let ok = 0;
    for (let a = 0; a < 10; a += 1) ok += await burst(service, 'aula-1', `alumno-${a}`, 10);
    expect(ok).toBe(50);
    const corte = await service.recordUserRequest('aula-1', 'alumno-0', NOW);
    expect(corte).toMatchObject({ allowed: false, bucket: 'authenticated', limit: 50 });
  });

  it('el tope es por aula: otra aula no se entera', async () => {
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '5';
    const service = new RateLimitService(await license('community'), makeRedis());
    for (let a = 0; a < 5; a += 1) await service.recordUserRequest('aula-1', `u${a}`, NOW);
    expect((await service.recordUserRequest('aula-1', 'u9', NOW)).allowed).toBe(false);
    expect((await service.recordUserRequest('aula-2', 'u9', NOW)).allowed).toBe(true);
  });

  it('cabeceras: el límite del usuario y el remaining más bajo de los dos', async () => {
    process.env['RATE_LIMIT_COMMUNITY_USER_PER_MIN'] = '300';
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '6000';
    const service = new RateLimitService(await license('community'), makeRedis());
    const d = await service.recordUserRequest('aula-1', 'u1', NOW);
    expect(d).toMatchObject({ allowed: true, bucket: 'user', limit: 300, remaining: 299 });
  });

  it('failsafe: sin Redis, o con Redis caído, se deja pasar', async () => {
    const sin = new RateLimitService(await license('community'), null);
    expect((await sin.recordUserRequest('aula-1', 'u1', NOW)).allowed).toBe(true);
    const roto = new RateLimitService(await license('community'), {
      incr: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      expire: vi.fn(async () => 1),
    });
    expect((await roto.recordUserRequest('aula-1', 'u1', NOW)).allowed).toBe(true);
  });
});

describe('RateLimitInterceptor · quién va a qué cubo', () => {
  function spy() {
    const calls: string[] = [];
    const allow = {
      allowed: true,
      limit: 1,
      remaining: 1,
      resetAt: new Date(0),
      tier: 'community' as const,
      bucket: 'user' as const,
    };
    const service = {
      recordUserRequest: vi.fn(async (t: string, u: string) => {
        calls.push(`user:${t}:${u}`);
        return allow;
      }),
      recordRequest: vi.fn(async (id: string, pub: boolean) => {
        calls.push(`${pub ? 'public' : 'tenant'}:${id}`);
        return allow;
      }),
    } as unknown as RateLimitService;
    return { service, calls };
  }

  async function run(service: RateLimitService, request: Record<string, unknown>) {
    const ctx = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ header: vi.fn() }) }),
    } as unknown as ExecutionContext;
    const out = new RateLimitInterceptor(service).intercept(ctx, { handle: () => of('ok') });
    await new Promise<void>((resolve) => out.subscribe({ complete: () => resolve() }));
  }

  it('una persona con sesión → su cubo por usuario', async () => {
    const { service, calls } = spy();
    await run(service, { url: '/api/v1/community/posts', user: { sub: 'u1', tenantId: 'aula-1' } });
    expect(calls).toEqual(['user:aula-1:u1']);
  });

  it('clave de API, clave de agente y SCIM → el cubo del aula, como antes', async () => {
    const { service, calls } = spy();
    const user = { sub: 'dueño-de-la-clave', tenantId: 'aula-1' };
    await run(service, { url: '/api/v1/courses', user, apiKeyId: 'key-1' });
    await run(service, { url: '/api/v1/agent/mcp', user, agentKey: { apiKeyId: 'key-2' } });
    await run(service, { url: '/scim/v2/Users', scimTenantId: 'aula-1' });
    expect(calls).toEqual(['tenant:aula-1', 'tenant:aula-1', 'tenant:aula-1']);
  });

  it('sin identidad → el cubo de su IP', async () => {
    const { service, calls } = spy();
    await run(service, { url: '/api/v1/auth/tenant-context', ip: '203.0.113.7' });
    expect(calls[0]).toMatch(/^public:anon:[0-9a-f]{16}$/);
  });

  it('el 429 dice qué cubo se agotó', async () => {
    const service = {
      recordUserRequest: vi.fn(async () => ({
        allowed: false,
        limit: 300,
        remaining: 0,
        resetAt: new Date(0),
        retryAfterSeconds: 12,
        tier: 'community' as const,
        bucket: 'user' as const,
      })),
    } as unknown as RateLimitService;
    const reply = { header: vi.fn() };
    const ctx = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ url: '/api/v1/x', user: { sub: 'u1', tenantId: 'aula-1' } }),
        getResponse: () => reply,
      }),
    } as unknown as ExecutionContext;
    const err = await new Promise<unknown>((resolve) =>
      new RateLimitInterceptor(service)
        .intercept(ctx, { handle: () => of('ok') })
        .subscribe({ error: resolve, complete: () => resolve(null) }),
    );
    expect((err as { getStatus(): number }).getStatus()).toBe(429);
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      code: 'rate_limit_exceeded',
      scope: 'user',
    });
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '12');
  });
});
