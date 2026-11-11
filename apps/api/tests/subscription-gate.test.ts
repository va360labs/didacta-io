/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Puerta de suscripción del tenant: estado efectivo, lista blanca del 402,
 * caché del servicio e interceptor.
 *
 * Lo que tiene que quedar fijado aquí, por orden de gravedad:
 *  1. Un aula abierta (Community siempre) no paga nada: ni 402, ni resolución
 *     de host, ni consultas por petición.
 *  2. Una prueba vencida se cierra sola aunque el plano de control no llame.
 *  3. Con la puerta cerrada, el login, `/me`, la marca y el estado de la
 *     puerta siguen vivos; el contenido no.
 */

import { HttpException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  effectiveGate,
  gatePath,
  isGateExempt,
  OPEN_GATE,
  SUBSCRIPTION_LOCKED_CODE,
  type GateRow,
} from '../src/tenancy/subscription-gate';
import { SubscriptionGateInterceptor } from '../src/tenancy/subscription-gate.interceptor';
import { SubscriptionGateService } from '../src/tenancy/subscription-gate.service';
import { tenantContextStorage } from '../src/tenancy/tenant-context.storage';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const ACTION = 'https://didacta.io/es/pricing?upgrade=tok_abc';

function row(partial: Partial<GateRow>): GateRow {
  return {
    subscriptionGateState: 'OPEN',
    subscriptionTrialEndsAt: null,
    subscriptionActionUrl: null,
    ...partial,
  };
}

describe('effectiveGate', () => {
  it('sin fila (tenant que nunca recibió la llamada) → OPEN', () => {
    expect(effectiveGate(null, NOW)).toEqual(OPEN_GATE);
    expect(effectiveGate(undefined, NOW)).toEqual(OPEN_GATE);
  });

  it('OPEN no arrastra fecha ni enlace aunque la fila los tuviera', () => {
    const g = effectiveGate(
      row({ subscriptionTrialEndsAt: new Date(NOW + 1000), subscriptionActionUrl: ACTION }),
      NOW,
    );
    expect(g).toEqual(OPEN_GATE);
  });

  it('TRIAL con días por delante sigue en TRIAL', () => {
    const ends = new Date(NOW + 3 * 86_400_000);
    expect(
      effectiveGate(
        row({
          subscriptionGateState: 'TRIAL',
          subscriptionTrialEndsAt: ends,
          subscriptionActionUrl: ACTION,
        }),
        NOW,
      ),
    ).toEqual({ state: 'TRIAL', trialEndsAt: ends, actionUrl: ACTION });
  });

  it('TRIAL vencida se lee como LOCKED aunque Cloud no haya llamado', () => {
    const ends = new Date(NOW - 1);
    expect(
      effectiveGate(
        row({
          subscriptionGateState: 'TRIAL',
          subscriptionTrialEndsAt: ends,
          subscriptionActionUrl: ACTION,
        }),
        NOW,
      ).state,
    ).toBe('LOCKED');
  });

  it('TRIAL que vence justo ahora ya está cerrada (el borde no regala un segundo)', () => {
    expect(
      effectiveGate(
        row({ subscriptionGateState: 'TRIAL', subscriptionTrialEndsAt: new Date(NOW) }),
        NOW,
      ).state,
    ).toBe('LOCKED');
  });

  it('LOCKED es LOCKED, con o sin fecha', () => {
    expect(effectiveGate(row({ subscriptionGateState: 'LOCKED' }), NOW).state).toBe('LOCKED');
  });
});

describe('lista blanca del 402', () => {
  it.each([
    ['GET', '/healthz'],
    ['GET', '/readyz'],
    ['GET', '/api/v1/setup/status'],
    ['GET', '/api/v1/tenancy/resolve'],
    ['GET', '/api/v1/auth/tenant-context'],
    ['POST', '/api/v1/auth/signin'],
    ['POST', '/api/v1/auth/refresh'],
    ['POST', '/api/v1/auth/forgot-password'],
    ['POST', '/api/v1/auth/reset-password'],
    ['POST', '/api/v1/auth/mfa/verify'],
    ['GET', '/api/v1/auth/oidc/acme/start'],
    ['POST', '/api/v1/auth/saml/acme/acs'],
    ['GET', '/api/v1/modules/wp-sso/acme/callback'],
    ['POST', '/api/v1/auth/support-access/redeem'],
    ['GET', '/api/v1/me/profile'],
    ['GET', '/api/v1/me/modules'],
    ['GET', '/api/v1/modules/theming/me'],
    ['GET', '/api/v1/modules/theming/tenants/abc/logo?v=3'],
    ['PUT', '/api/v1/admin/tenants/abc/subscription-gate'],
    ['GET', '/api/v1/admin/tenants'],
    ['POST', '/api/v1/modules/billing/webhook'],
    ['POST', '/api/v1/modules/subscriptions/webhook'],
    ['POST', '/api/v1/modules/payment-connections/woo-webhook'],
    ['POST', '/api/v1/webhooks/zoom'],
  ])('%s %s sigue respondiendo', (method, url) => {
    expect(isGateExempt(method, url)).toBe(true);
  });

  it.each([
    ['GET', '/api/v1/modules/courses'],
    ['GET', '/api/v1/modules/courses/abc/lessons'],
    ['GET', '/api/v1/modules/community/posts'],
    ['POST', '/api/v1/auth/signup'],
    ['PATCH', '/api/v1/me/profile'],
    ['GET', '/api/v1/me/notifications'],
    ['GET', '/api/v1/public/site-context'],
    ['POST', '/api/v1/modules/billing/checkout'],
    ['PUT', '/api/v1/modules/theming/me'],
    ['GET', '/scim/v2/Users'],
    ['GET', '/api/v1/integrations/enrollments'],
    // Un prefijo no se cuela por parecido: `/admin/tenants-x` no es `/admin/tenants`.
    ['GET', '/api/v1/admin/tenantsx'],
    ['GET', '/api/v1/me/profile-stats'],
  ])('%s %s queda cerrado', (method, url) => {
    expect(isGateExempt(method, url)).toBe(false);
  });

  it('HEAD y OPTIONS de una ruta GET abierta también pasan', () => {
    expect(isGateExempt('HEAD', '/healthz')).toBe(true);
    expect(isGateExempt('OPTIONS', '/api/v1/auth/tenant-context')).toBe(true);
  });

  it('gatePath quita query, barra final y el prefijo de la API', () => {
    expect(gatePath('/api/v1/me/profile/?x=1')).toBe('/me/profile');
    expect(gatePath('/healthz')).toBe('/healthz');
    expect(gatePath(undefined)).toBe('/');
  });
});

/** Prisma mínimo: solo la lectura de la foto de puertas. */
function makeService(rows: Array<{ id: string } & GateRow>) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const resolveByHost = vi.fn().mockResolvedValue({ id: 'tenant-host' });
  const service = new SubscriptionGateService(
    { tenant: { findMany } } as never,
    { resolveByHost } as never,
  );
  return { service, findMany, resolveByHost };
}

describe('SubscriptionGateService', () => {
  it('sin puertas cerradas: anyGated=false y todos los tenants OPEN', async () => {
    const { service } = makeService([]);
    expect(await service.anyGated()).toBe(false);
    expect(await service.gateFor('cualquiera')).toEqual(OPEN_GATE);
  });

  it('la foto se cachea: N lecturas seguidas son UNA consulta', async () => {
    const { service, findMany } = makeService([]);
    await Promise.all([service.anyGated(), service.anyGated(), service.gateFor('a')]);
    await service.anyGated();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('solo pide las filas que no están en OPEN', async () => {
    const { service, findMany } = makeService([]);
    await service.anyGated();
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { deletedAt: null, subscriptionGateState: { not: 'OPEN' } },
    });
  });

  it('invalidate() obliga a releer', async () => {
    const { service, findMany } = makeService([]);
    await service.anyGated();
    service.invalidate();
    await service.anyGated();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('devuelve el estado efectivo: una TRIAL vencida sale LOCKED', async () => {
    const { service } = makeService([
      {
        id: 't1',
        subscriptionGateState: 'TRIAL',
        subscriptionTrialEndsAt: new Date(Date.now() - 60_000),
        subscriptionActionUrl: ACTION,
      },
    ]);
    expect((await service.gateFor('t1')).state).toBe('LOCKED');
  });

  it('si la base falla, falla ABIERTA (un parpadeo no cierra el pool)', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const service = new SubscriptionGateService(
      { tenant: { findMany } } as never,
      { resolveByHost: vi.fn() } as never,
    );
    expect(await service.anyGated()).toBe(false);
    expect((await service.gateFor('t1')).state).toBe('OPEN');
  });

  it('el host se resuelve una vez y se cachea', async () => {
    const { service, resolveByHost } = makeService([]);
    expect(await service.tenantIdForHost('acme.didacta.io')).toBe('tenant-host');
    expect(await service.tenantIdForHost('acme.didacta.io')).toBe('tenant-host');
    expect(resolveByHost).toHaveBeenCalledTimes(1);
    expect(await service.tenantIdForHost(undefined)).toBeNull();
  });
});

/** Contexto HTTP falso con lo que mira el interceptor. */
function httpContext(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const NEXT: CallHandler = { handle: () => of('contenido') };

function gateStub(opts: { gated: boolean; state?: 'OPEN' | 'TRIAL' | 'LOCKED' }) {
  return {
    anyGated: vi.fn().mockResolvedValue(opts.gated),
    gateFor: vi.fn().mockResolvedValue({
      state: opts.state ?? 'OPEN',
      trialEndsAt: null,
      actionUrl: null,
    }),
    tenantIdForHost: vi.fn().mockResolvedValue('tenant-host'),
  };
}

async function run(
  interceptor: SubscriptionGateInterceptor,
  req: Record<string, unknown>,
): Promise<{ status: number | null; code: string | null }> {
  try {
    await interceptor.intercept(httpContext(req), NEXT);
    return { status: null, code: null };
  } catch (err) {
    if (err instanceof HttpException) {
      const body = err.getResponse() as { code?: string };
      return { status: err.getStatus(), code: body.code ?? null };
    }
    throw err;
  }
}

describe('SubscriptionGateInterceptor', () => {
  let locked: ReturnType<typeof gateStub>;

  beforeEach(() => {
    locked = gateStub({ gated: true, state: 'LOCKED' });
  });

  it('OPEN (Community): ni consulta el tenant ni resuelve el host', async () => {
    const gate = gateStub({ gated: false });
    const res = await run(new SubscriptionGateInterceptor(gate as never), {
      method: 'GET',
      url: '/api/v1/modules/courses',
      headers: { host: 'aula.example.com' },
    });
    expect(res.status).toBeNull();
    expect(gate.gateFor).not.toHaveBeenCalled();
    expect(gate.tenantIdForHost).not.toHaveBeenCalled();
  });

  it('LOCKED: el contenido de un usuario con sesión → 402 SUBSCRIPTION_LOCKED', async () => {
    const res = await run(new SubscriptionGateInterceptor(locked as never), {
      method: 'GET',
      url: '/api/v1/modules/courses',
      headers: {},
      user: { sub: 'u1', tenantId: 't1', roles: ['alumno'] },
    });
    expect(res).toEqual({ status: 402, code: SUBSCRIPTION_LOCKED_CODE });
    expect(locked.gateFor).toHaveBeenCalledWith('t1');
    expect(locked.tenantIdForHost).not.toHaveBeenCalled();
  });

  it('LOCKED: el administrador tampoco lee contenido (se le cierra igual)', async () => {
    const res = await run(new SubscriptionGateInterceptor(locked as never), {
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: {},
      user: { sub: 'u1', tenantId: 't1', roles: ['tenant_admin'] },
    });
    expect(res.status).toBe(402);
  });

  it('LOCKED: el login, /me y la marca siguen vivos', async () => {
    const interceptor = new SubscriptionGateInterceptor(locked as never);
    for (const [method, url] of [
      ['POST', '/api/v1/auth/signin'],
      ['GET', '/api/v1/me/modules'],
      ['GET', '/api/v1/auth/tenant-context'],
      ['GET', '/api/v1/modules/theming/me'],
    ] as const) {
      const res = await run(interceptor, { method, url, headers: {} });
      expect(res.status, `${method} ${url}`).toBeNull();
    }
  });

  it('LOCKED sin sesión: el tenant sale del host y el catálogo público da 402', async () => {
    const res = await run(new SubscriptionGateInterceptor(locked as never), {
      method: 'GET',
      url: '/api/v1/public/site-context',
      headers: { 'x-forwarded-host': 'acme.didacta.io' },
    });
    expect(res.status).toBe(402);
    expect(locked.tenantIdForHost).toHaveBeenCalledWith('acme.didacta.io');
  });

  it('el tenant del contexto de la petición (ApiKey) también cuenta', async () => {
    const interceptor = new SubscriptionGateInterceptor(locked as never);
    const res = await tenantContextStorage.run({ tenantId: 't-key', traceId: 'x' }, () =>
      run(interceptor, { method: 'GET', url: '/api/v1/integrations/enrollments', headers: {} }),
    );
    expect(res.status).toBe(402);
    expect(locked.gateFor).toHaveBeenCalledWith('t-key');
  });

  it('TRIAL sigue sirviendo contenido', async () => {
    const trial = gateStub({ gated: true, state: 'TRIAL' });
    const res = await run(new SubscriptionGateInterceptor(trial as never), {
      method: 'GET',
      url: '/api/v1/modules/courses',
      headers: {},
      user: { sub: 'u1', tenantId: 't1', roles: ['alumno'] },
    });
    expect(res.status).toBeNull();
  });

  it('la credencial de provisioning nunca se cierra (es quien abre la puerta)', async () => {
    const res = await run(new SubscriptionGateInterceptor(locked as never), {
      method: 'GET',
      url: '/api/v1/admin/system/health',
      headers: {},
      provisioningActor: { credentialId: 'c1' },
    });
    expect(res.status).toBeNull();
    expect(locked.anyGated).not.toHaveBeenCalled();
  });

  it('un host que no es de nadie no se cierra (ese caso ya lo contesta otra puerta)', async () => {
    locked.tenantIdForHost.mockResolvedValue(null);
    const res = await run(new SubscriptionGateInterceptor(locked as never), {
      method: 'GET',
      url: '/api/v1/public/site-context',
      headers: { host: 'nadie.example.com' },
    });
    expect(res.status).toBeNull();
  });

  it('lo que no es HTTP (colas, cron) no pasa por la puerta', async () => {
    const ctx = { getType: () => 'rpc' } as unknown as ExecutionContext;
    await new SubscriptionGateInterceptor(locked as never).intercept(ctx, NEXT);
    expect(locked.anyGated).not.toHaveBeenCalled();
  });
});

describe('el núcleo no decide cerrar nada solo', () => {
  it('subscription-gate.ts no importa el SDK de licencias ni cuenta miembros', () => {
    // Misma barrera que `signup-freeze.test.ts`: la política (días, planes,
    // tope de alumnos) vive en el plano de control. Si alguien la mete aquí,
    // Community pasa a ser una versión capada.
    const src = readFileSync(join(process.cwd(), 'src', 'tenancy', 'subscription-gate.ts'), 'utf8');
    expect(src).not.toMatch(/license-sdk|LicenseService/);
    expect(src).not.toMatch(/\.count\(|groupBy\(/);
  });
});
