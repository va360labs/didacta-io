/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Cubo por usuario, tope por aula y limitador del acceso contra un Redis REAL:
 * INCR atómico bajo concurrencia, caducidad de verdad y el arreglo de una
 * clave sin TTL. Los dobles en memoria de los unitarios no prueban nada de
 * eso.
 *
 * Necesita `REDIS_URL` (sin ella se salta, igual que los de base de datos sin
 * `ADMIN_DATABASE_URL`). Cada ejecución usa aulas, usuarios, IP y correos
 * nuevos: no hace falta vaciar Redis ni pisa a nadie.
 */

import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LicenseService } from '@didacta/license-sdk';
import {
  RateLimitService,
  type RateLimitRedisClient,
} from '../../src/rate-limit/rate-limit.service';
import {
  LoginLimitService,
  type LoginLimitRedisClient,
} from '../../src/rate-limit/login-limit.service';
import { LOGIN_LIMIT_POLICIES } from '../../src/rate-limit/login-limit.types';

const REDIS_URL = process.env['REDIS_URL'];
const describeWithRedis = REDIS_URL ? describe : describe.skip;

const ENV = [
  'RATE_LIMIT_COMMUNITY_USER_PER_MIN',
  'RATE_LIMIT_COMMUNITY_AUTH_PER_MIN',
  'RATE_LIMIT_LOGIN_IP_MAX',
  'RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS',
  'RATE_LIMIT_LOGIN_ACCOUNT_MAX',
  'RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS',
] as const;

describeWithRedis('rate limit con Redis real', () => {
  let redis: IORedis;
  let backup: Record<string, string | undefined> = {};

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL!, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });
  afterAll(async () => {
    await redis.quit();
  });
  beforeEach(() => {
    backup = {};
    for (const k of ENV) backup[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV) {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    }
  });

  async function community(): Promise<LicenseService> {
    const l = new LicenseService();
    await l.load({ key: null });
    return l;
  }

  it('cubo por usuario y tope por aula, con ráfagas en paralelo', async () => {
    process.env['RATE_LIMIT_COMMUNITY_USER_PER_MIN'] = '20';
    process.env['RATE_LIMIT_COMMUNITY_AUTH_PER_MIN'] = '50';
    const service = new RateLimitService(
      await community(),
      redis as unknown as RateLimitRedisClient,
    );
    const aula = `aula-${randomUUID()}`;
    const now = new Date();

    // Un usuario desbocado: 60 a la vez → pasan exactamente 20.
    const desbocado = await Promise.all(
      Array.from({ length: 60 }, () => service.recordUserRequest(aula, 'desbocado', now)),
    );
    expect(desbocado.filter((d) => d.allowed)).toHaveLength(20);
    expect(desbocado.filter((d) => !d.allowed).every((d) => d.bucket === 'user')).toBe(true);

    // Sus compañeros no lo notan: 3 alumnos × 10 = 30 → el aula llega a 50 justos.
    for (const alumno of ['a', 'b', 'c']) {
      const r = await Promise.all(
        Array.from({ length: 10 }, () => service.recordUserRequest(aula, alumno, now)),
      );
      expect(r.every((d) => d.allowed)).toBe(true);
    }
    // El tope del aula: el siguiente, aunque sea su primera petición, no cabe.
    const tope = await service.recordUserRequest(aula, 'd', now);
    expect(tope).toMatchObject({ allowed: false, bucket: 'authenticated', limit: 50 });

    // Las claves caducan solas (ventana + 5 s de gracia).
    const minute = Math.floor(now.getTime() / 60_000);
    const ttl = await redis.ttl(`ratelimit:${aula}:user:desbocado:${minute}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(65);
  });

  it('acceso: bloqueo por cuenta con caducidad real, y un éxito lo pone a cero', async () => {
    process.env['RATE_LIMIT_LOGIN_ACCOUNT_MAX'] = '3';
    process.env['RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS'] = '2';
    const limiter = new LoginLimitService(redis as unknown as LoginLimitRedisClient);
    const policy = LOGIN_LIMIT_POLICIES.signin;
    const keys = (ip: string) => ({ ip: `ip-${ip}`, account: `email:${randomUUID()}` });
    const k = keys(randomUUID());

    for (let n = 0; n < 3; n += 1) {
      expect((await limiter.begin({ ...k, ip: `ip-${randomUUID()}` })).allowed).toBe(true);
    }
    const bloqueado = await limiter.begin({ ...k, ip: `ip-${randomUUID()}` });
    expect(bloqueado.allowed).toBe(false);
    if (!bloqueado.allowed) expect(bloqueado.retryAfterSeconds).toBeLessThanOrEqual(2);

    await new Promise((r) => setTimeout(r, 2_200));
    const otraVez = await limiter.begin({ ...k, ip: `ip-${randomUUID()}` });
    expect(otraVez.allowed).toBe(true);

    // Un login correcto borra los fallos de la cuenta.
    if (otraVez.allowed) await limiter.settle(k, otraVez.counted, policy, 'success');
    expect(await redis.exists(`loginlimit:acct:${k.account}`)).toBe(0);
  });

  it('acceso: 40 intentos a la vez contra una cuenta → pasan exactamente 10', async () => {
    const limiter = new LoginLimitService(redis as unknown as LoginLimitRedisClient);
    const account = `email:${randomUUID()}`;
    const res = await Promise.all(
      Array.from({ length: 40 }, () => limiter.begin({ ip: `ip-${randomUUID()}`, account })),
    );
    expect(res.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('acceso: una clave que se quedó sin TTL no bloquea para siempre', async () => {
    const limiter = new LoginLimitService(redis as unknown as LoginLimitRedisClient);
    const account = `email:${randomUUID()}`;
    await redis.set(`loginlimit:acct:${account}`, '50'); // sin EXPIRE
    const r = await limiter.begin({ ip: null, account });
    expect(r.allowed).toBe(false);
    const ttl = await redis.ttl(`loginlimit:acct:${account}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });
});
