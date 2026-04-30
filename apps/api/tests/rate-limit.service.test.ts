/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del RateLimitService — sexto piloto License SDK
 * (capability `feat:api.rate_limit.elevated`).
 *
 * Mockeamos el cliente Redis con un `Map` en memoria — esto nos permite
 * ejercitar la lógica de sliding window, INCR atómico y reset en cambio
 * de minuto sin levantar Redis real. La integración con Redis real
 * (compose-test) queda cubierta aparte, fuera de este test unitario.
 *
 * Cobertura mínima exigida (≥ 10 casos):
 *   1. Sin licencia → tier `community` y límites community.
 *   2. Con dev bypass → tier `enterprise` y límites enterprise.
 *   3. Sliding window: N req permitidas, N+1 rechazada.
 *   4. Reset al cambiar de minuto (advance time).
 *   5. Failsafe Redis caído (incr lanza) → permite la request.
 *   6. Failsafe Redis no inyectado → permite la request.
 *   7. Tenant A no consume cuota de tenant B (aislamiento por bucket).
 *   8. Bucket público vs autenticado son independientes para el mismo tenant.
 *   9. Decision contiene los headers correctos en allowed (limit, remaining, resetAt).
 *  10. Decision contiene Retry-After en denied.
 *  11. RateLimitTier reacciona a cambio dinámico de licencia (recarga).
 *  12. Override por env (RATE_LIMIT_COMMUNITY_AUTH_PER_MIN) tiene efecto.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LicenseService } from '@didacta/license-sdk';
import { RateLimitService, type RateLimitRedisClient } from '../src/rate-limit/rate-limit.service';
import { DEFAULT_RATE_LIMIT_CONFIG } from '../src/rate-limit/rate-limit.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock de Redis basado en Map. Soporta INCR (con creación implícita en 0)
 * y EXPIRE (no-op pero contabilizado). Suficiente para el modelo del piloto.
 */
function makeRedisMock(): RateLimitRedisClient & {
  __store: Map<string, number>;
  __ttls: Map<string, number>;
  incrSpy: ReturnType<typeof vi.fn>;
  expireSpy: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  const incrSpy = vi.fn(async (key: string) => {
    const next = (store.get(key) ?? 0) + 1;
    store.set(key, next);
    return next;
  });
  const expireSpy = vi.fn(async (key: string, seconds: number) => {
    ttls.set(key, seconds);
    return 1;
  });
  return {
    incr: incrSpy,
    expire: expireSpy,
    __store: store,
    __ttls: ttls,
    incrSpy,
    expireSpy,
  };
}

/** Mock que siempre lanza en INCR — simula caída de Redis. */
function makeBrokenRedisMock(): RateLimitRedisClient {
  return {
    incr: vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }),
    expire: vi.fn(async () => 1),
  };
}

/**
 * Construye un `LicenseService` con estado dado. `dev` activa el bypass,
 * `community` deja el estado por defecto sin key.
 */
async function makeLicense(state: 'community' | 'dev'): Promise<LicenseService> {
  const license = new LicenseService();
  if (state === 'dev') {
    await license.load({ allowDevBypass: true, key: 'whatever' });
  } else {
    await license.load({ key: null });
  }
  return license;
}

// Backup de env vars que mutamos en algunos tests.
const ENV_KEYS = [
  'RATE_LIMIT_COMMUNITY_AUTH_PER_MIN',
  'RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN',
  'RATE_LIMIT_ENTERPRISE_AUTH_PER_MIN',
  'RATE_LIMIT_ENTERPRISE_PUBLIC_PER_MIN',
  'RATE_LIMIT_WINDOW_SECONDS',
] as const;

let envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = envBackup[k];
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RateLimitService · gate feat:api.rate_limit.elevated', () => {
  // -------------------------------------------------------------------------
  // 1. Sin licencia → tier community.
  // -------------------------------------------------------------------------
  it('[community] sin licencia → getCurrentTier() === "community"', async () => {
    const license = await makeLicense('community');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);
    expect(service.getCurrentTier()).toBe('community');
  });

  it('[community] usa límites community (100 auth, 30 public) por defecto', async () => {
    const license = await makeLicense('community');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);

    const authDec = await service.recordRequest('tenant-1', false);
    expect(authDec.tier).toBe('community');
    expect(authDec.bucket).toBe('authenticated');
    expect(authDec.limit).toBe(DEFAULT_RATE_LIMIT_CONFIG.community.authenticated);

    const pubDec = await service.recordRequest('tenant-1', true);
    expect(pubDec.bucket).toBe('public');
    expect(pubDec.limit).toBe(DEFAULT_RATE_LIMIT_CONFIG.community.public);
  });

  // -------------------------------------------------------------------------
  // 2. Con dev bypass → tier enterprise.
  // -------------------------------------------------------------------------
  it('[enterprise] dev bypass → getCurrentTier() === "enterprise"', async () => {
    const license = await makeLicense('dev');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);
    expect(service.getCurrentTier()).toBe('enterprise');

    const authDec = await service.recordRequest('tenant-1', false);
    expect(authDec.limit).toBe(DEFAULT_RATE_LIMIT_CONFIG.enterprise.authenticated);
    expect(authDec.tier).toBe('enterprise');
  });

  // -------------------------------------------------------------------------
  // 3. Sliding window: límite + 1 → rechazada.
  // -------------------------------------------------------------------------
  it('[sliding window] respeta el límite community auth (100 OK, 101 rechazada)', async () => {
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '5'; // límite chico para no iterar 100 veces
    const license = await makeLicense('community');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);
    const now = new Date('2026-04-30T10:00:00.000Z');

    for (let i = 1; i <= 5; i++) {
      const dec = await service.recordRequest('tenant-1', false, now);
      expect(dec.allowed).toBe(true);
      expect(dec.remaining).toBe(5 - i);
    }

    const denied = await service.recordRequest('tenant-1', false, now);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.limit).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 4. Reset al cambiar minuto.
  // -------------------------------------------------------------------------
  it('[reset] cambio de minuto natural reinicia el bucket', async () => {
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '2';
    const license = await makeLicense('community');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);

    const t0 = new Date('2026-04-30T10:00:30.000Z'); // minuto 10:00
    await service.recordRequest('tenant-1', false, t0);
    await service.recordRequest('tenant-1', false, t0);
    const denied = await service.recordRequest('tenant-1', false, t0);
    expect(denied.allowed).toBe(false);

    // Avanzamos al siguiente minuto natural — clave Redis distinta.
    const t1 = new Date('2026-04-30T10:01:00.000Z');
    const after = await service.recordRequest('tenant-1', false, t1);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(1); // limit=2, count=1 tras este INCR
  });

  // -------------------------------------------------------------------------
  // 5. Failsafe — Redis lanza error.
  // -------------------------------------------------------------------------
  it('[failsafe] Redis lanza en INCR → la request se permite igual', async () => {
    const license = await makeLicense('community');
    const broken = makeBrokenRedisMock();
    const service = new RateLimitService(license, broken);

    const dec = await service.recordRequest('tenant-1', false);
    expect(dec.allowed).toBe(true);
    expect(dec.tier).toBe('community');
    // En modo open, remaining se reporta = limit (la cuenta no se incrementó).
    expect(dec.remaining).toBe(DEFAULT_RATE_LIMIT_CONFIG.community.authenticated);
  });

  // -------------------------------------------------------------------------
  // 6. Failsafe — Redis no inyectado.
  // -------------------------------------------------------------------------
  it('[failsafe] Redis no inyectado → permite la request', async () => {
    const license = await makeLicense('community');
    const service = new RateLimitService(license, null);
    const dec = await service.recordRequest('tenant-1', false);
    expect(dec.allowed).toBe(true);
    expect(dec.remaining).toBe(DEFAULT_RATE_LIMIT_CONFIG.community.authenticated);
  });

  // -------------------------------------------------------------------------
  // 7. Aislamiento por tenant.
  // -------------------------------------------------------------------------
  it('[tenant isolation] tenant A no consume cuota de tenant B', async () => {
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '2';
    const license = await makeLicense('community');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);
    const now = new Date('2026-04-30T10:00:30.000Z');

    await service.recordRequest('tenant-A', false, now);
    await service.recordRequest('tenant-A', false, now);
    const denyA = await service.recordRequest('tenant-A', false, now);
    expect(denyA.allowed).toBe(false);

    // tenant-B en la misma ventana no se ve afectado.
    const okB = await service.recordRequest('tenant-B', false, now);
    expect(okB.allowed).toBe(true);
    expect(okB.remaining).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 8. Buckets públicos vs autenticados.
  // -------------------------------------------------------------------------
  it('[bucket isolation] mismo tenant: bucket auth y public no se contaminan', async () => {
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '2';
    process.env['RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN'] = '2';
    const license = await makeLicense('community');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);
    const now = new Date('2026-04-30T10:00:30.000Z');

    await service.recordRequest('tenant-1', false, now); // auth #1
    await service.recordRequest('tenant-1', false, now); // auth #2 (limit)
    const denyAuth = await service.recordRequest('tenant-1', false, now);
    expect(denyAuth.allowed).toBe(false);

    // El público sigue libre.
    const okPub = await service.recordRequest('tenant-1', true, now);
    expect(okPub.allowed).toBe(true);
    expect(okPub.bucket).toBe('public');
    expect(okPub.remaining).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 9. Headers correctos en allowed.
  // -------------------------------------------------------------------------
  it('[headers allowed] decision incluye limit/remaining/resetAt coherentes', async () => {
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '5';
    const license = await makeLicense('community');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);
    const now = new Date('2026-04-30T10:00:30.000Z'); // minuto 10:00

    const dec = await service.recordRequest('tenant-1', false, now);
    expect(dec.limit).toBe(5);
    expect(dec.remaining).toBe(4);
    // resetAt es el siguiente borde de minuto (10:01:00).
    expect(dec.resetAt.toISOString()).toBe('2026-04-30T10:01:00.000Z');
    expect(dec.retryAfterSeconds).toBeUndefined();
    expect(dec.tier).toBe('community');
    expect(dec.bucket).toBe('authenticated');
  });

  // -------------------------------------------------------------------------
  // 10. Headers correctos en denied (Retry-After).
  // -------------------------------------------------------------------------
  it('[headers denied] decision rechazada tiene retryAfterSeconds positivo', async () => {
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '1';
    const license = await makeLicense('community');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);
    const now = new Date('2026-04-30T10:00:30.000Z'); // 30s en el minuto

    await service.recordRequest('tenant-1', false, now);
    const denied = await service.recordRequest('tenant-1', false, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // 30s hasta el final del minuto → retryAfterSeconds === 30.
    expect(denied.retryAfterSeconds).toBe(30);
    expect(denied.remaining).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 11. Tier dinámico: cambio de licencia en runtime.
  // -------------------------------------------------------------------------
  it('[tier dinámico] recargar licencia cambia el tier devuelto', async () => {
    const license = new LicenseService();
    await license.load({ key: null });
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);
    expect(service.getCurrentTier()).toBe('community');

    // Recargamos con dev bypass — esto es lo que hace el SDK cuando un admin
    // sube una nueva licencia o se levanta dev mode.
    await license.load({ allowDevBypass: true, key: 'dev' });
    expect(service.getCurrentTier()).toBe('enterprise');

    // Y volver a community.
    await license.load({ key: null });
    expect(service.getCurrentTier()).toBe('community');
  });

  // -------------------------------------------------------------------------
  // 12. Override env tiene efecto.
  // -------------------------------------------------------------------------
  it('[env override] RATE_LIMIT_COMMUNITY_AUTH_PER_MIN se respeta', async () => {
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '7';
    const license = await makeLicense('community');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);
    const dec = await service.recordRequest('tenant-1', false);
    expect(dec.limit).toBe(7);
    expect(dec.remaining).toBe(6);
  });

  // -------------------------------------------------------------------------
  // Casos extra (relevantes pero no exigidos en el listado mínimo).
  // -------------------------------------------------------------------------

  it('[anonymous] tenantId vacío/null se mapea a "anonymous"', async () => {
    process.env['RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN'] = '2';
    const license = await makeLicense('community');
    const redis = makeRedisMock();
    const service = new RateLimitService(license, redis);
    const now = new Date('2026-04-30T10:00:00.000Z');

    await service.recordRequest(null, true, now);
    await service.recordRequest('', true, now);
    const denied = await service.recordRequest(undefined, true, now);
    expect(denied.allowed).toBe(false);

    // Verificamos que la clave Redis usada es 'anonymous'.
    const keys = Array.from(redis.__store.keys());
    expect(keys.length).toBe(1);
    const expectedMinute = Math.floor(now.getTime() / 60_000);
    expect(keys[0]).toBe(`ratelimit:anonymous:public:${expectedMinute}`);
  });
});
