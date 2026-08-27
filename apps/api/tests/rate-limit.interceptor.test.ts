/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Regresión del rate limit anónimo global reportado por Bruno
 * (ingenierosindustriales.com) sobre v0.1.0-beta.7. Ver SECURITY-CREDITS.md.
 *
 * El defecto: toda petición sin identidad resuelta usaba la clave literal
 * `'anonymous'`, así que los 30 req/min del plan Community eran un ÚNICO cubo
 * para todos los visitantes de la instancia. Un cliente podía vaciarlo y dejar
 * el catálogo y el acceso en 429 para gente sin relación con él.
 */

import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import { RateLimitInterceptor } from '../src/rate-limit/rate-limit.interceptor';
import type { RateLimitService } from '../src/rate-limit/rate-limit.service';

/** Captura los identificadores con los que el interceptor llama al service. */
function makeRateLimitSpy() {
  const seen: Array<{ identifier: string | null | undefined; isPublic: boolean }> = [];
  const service = {
    recordRequest: vi.fn(async (identifier: string, isPublic: boolean) => {
      seen.push({ identifier, isPublic });
      return {
        allowed: true,
        limit: 30,
        remaining: 29,
        resetAt: new Date(0),
        tier: 'community' as const,
        bucket: isPublic ? ('public' as const) : ('authenticated' as const),
      };
    }),
  } as unknown as RateLimitService;
  return { service, seen };
}

function makeContext(request: Record<string, unknown>): ExecutionContext {
  const reply = { header: vi.fn() };
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
}

const nextHandler = { handle: () => of('ok') };

async function run(interceptor: RateLimitInterceptor, request: Record<string, unknown>) {
  const result = interceptor.intercept(makeContext(request), nextHandler);
  await new Promise<void>((resolve) => result.subscribe({ complete: () => resolve() }));
}

describe('RateLimitInterceptor · identidad del cubo anónimo', () => {
  it('dos IPs distintas NO comparten cubo', async () => {
    const { service, seen } = makeRateLimitSpy();
    const interceptor = new RateLimitInterceptor(service);

    await run(interceptor, { url: '/api/v1/catalogo', ip: '203.0.113.10' });
    await run(interceptor, { url: '/api/v1/catalogo', ip: '198.51.100.20' });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.isPublic).toBe(true);
    // Lo que importa: identificadores distintos. Antes los dos eran 'anonymous'.
    expect(seen[0]?.identifier).not.toBe(seen[1]?.identifier);
    // Y ninguno es ya el cubo global compartido.
    expect(seen[0]?.identifier).not.toBe('anonymous');
  });

  it('la misma IP cae siempre en el mismo cubo', async () => {
    const { service, seen } = makeRateLimitSpy();
    const interceptor = new RateLimitInterceptor(service);

    await run(interceptor, { url: '/api/v1/catalogo', ip: '203.0.113.10' });
    await run(interceptor, { url: '/api/v1/otra-cosa', ip: '203.0.113.10' });

    expect(seen[0]?.identifier).toBe(seen[1]?.identifier);
  });

  it('la IP no viaja en claro a Redis', async () => {
    const { service, seen } = makeRateLimitSpy();
    const interceptor = new RateLimitInterceptor(service);

    await run(interceptor, { url: '/api/v1/catalogo', ip: '203.0.113.10' });

    expect(seen[0]?.identifier).not.toContain('203.0.113.10');
    expect(seen[0]?.identifier).toMatch(/^anon:[0-9a-f]{16}$/);
  });

  it('las IPv6 se agrupan por /64 — un cliente doméstico no tiene miles de cubos', async () => {
    const { service, seen } = makeRateLimitSpy();
    const interceptor = new RateLimitInterceptor(service);

    await run(interceptor, { url: '/api/v1/catalogo', ip: '2001:db8:1:2:aaaa::1' });
    await run(interceptor, { url: '/api/v1/catalogo', ip: '2001:db8:1:2:bbbb::9' });
    // Otra /64 distinta sí es otro cubo.
    await run(interceptor, { url: '/api/v1/catalogo', ip: '2001:db8:1:99:aaaa::1' });

    expect(seen[0]?.identifier).toBe(seen[1]?.identifier);
    expect(seen[0]?.identifier).not.toBe(seen[2]?.identifier);
  });

  it('sin IP se cae al cubo compartido, no se deja de limitar', async () => {
    const { service, seen } = makeRateLimitSpy();
    const interceptor = new RateLimitInterceptor(service);

    await run(interceptor, { url: '/api/v1/catalogo' });

    expect(seen[0]?.identifier).toBe('anonymous');
    expect(seen[0]?.isPublic).toBe(true);
  });

  it('el tráfico autenticado sigue contando por tenant, no por IP', async () => {
    const { service, seen } = makeRateLimitSpy();
    const interceptor = new RateLimitInterceptor(service);

    await run(interceptor, {
      url: '/api/v1/cursos',
      ip: '203.0.113.10',
      user: { tenantId: 'tenant-abc' },
    });

    expect(seen[0]?.identifier).toBe('tenant-abc');
    expect(seen[0]?.isPublic).toBe(false);
  });

  it('los endpoints exentos no tocan el limitador', async () => {
    const { service, seen } = makeRateLimitSpy();
    const interceptor = new RateLimitInterceptor(service);

    await run(interceptor, { url: '/healthz', ip: '203.0.113.10' });
    await run(interceptor, { url: '/metrics', ip: '203.0.113.10' });

    expect(seen).toHaveLength(0);
  });
});
