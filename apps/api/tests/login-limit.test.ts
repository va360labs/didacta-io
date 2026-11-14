/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Limitador propio del acceso (login, alta, restablecer contraseña, MFA).
 *
 * Antes solo los protegía el cupo público general (30/min por IP) y no había
 * bloqueo por cuenta: desde muchas IP se podían probar contraseñas contra la
 * misma cuenta sin freno.
 */

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError, type Observable } from 'rxjs';
import {
  LOGIN_LIMIT_KEY,
  LoginLimitInterceptor,
  loginAccountKey,
} from '../src/rate-limit/login-limit.interceptor';
import {
  LoginLimitService,
  type LoginLimitRedisClient,
} from '../src/rate-limit/login-limit.service';
import {
  LOGIN_LIMIT_POLICIES,
  resolveLoginLimitConfig,
  type LoginLimitKind,
} from '../src/rate-limit/login-limit.types';
import { AuthController } from '../src/auth/auth.controller';
import { MfaController } from '../src/auth/mfa.controller';
import { SupportAccessController } from '../src/admin/support-access.controller';

/** Redis en memoria con caducidad real sobre un reloj que mueve el test. */
function makeRedis(clock: { now: number }): LoginLimitRedisClient & { keys(): string[] } {
  const store = new Map<string, { value: number; expiresAt: number | null }>();
  const live = (key: string) => {
    const e = store.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= clock.now) {
      store.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    keys: () => [...store.keys()].filter((k) => live(k)),
    incr: vi.fn(async (key: string) => {
      const e = live(key) ?? { value: 0, expiresAt: null };
      e.value += 1;
      store.set(key, e);
      return e.value;
    }),
    decr: vi.fn(async (key: string) => {
      const e = live(key) ?? { value: 0, expiresAt: null };
      e.value -= 1;
      store.set(key, e);
      return e.value;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      const e = live(key);
      if (!e) return 0;
      e.expiresAt = clock.now + seconds * 1000;
      return 1;
    }),
    ttl: vi.fn(async (key: string) => {
      const e = live(key);
      if (!e) return -2;
      if (e.expiresAt === null) return -1;
      return Math.ceil((e.expiresAt - clock.now) / 1000);
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

const ENV = [
  'RATE_LIMIT_LOGIN_IP_MAX',
  'RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS',
  'RATE_LIMIT_LOGIN_ACCOUNT_MAX',
  'RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS',
  'AUTH_SECRET',
] as const;
let backup: Record<string, string | undefined> = {};
let clock: { now: number };
let redis: ReturnType<typeof makeRedis>;

beforeEach(() => {
  backup = {};
  for (const k of ENV) {
    backup[k] = process.env[k];
    delete process.env[k];
  }
  clock = { now: Date.parse('2026-11-14T10:00:00Z') };
  redis = makeRedis(clock);
});
afterEach(() => {
  for (const k of ENV) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

/** Lo que contesta el handler real, sin saber nada del limitador. */
type Outcome = 'ok' | 'credenciales' | 'mfa' | 'servidor';

const CUENTAS_QUE_EXISTEN = new Set(['ana@aula.test']);

function handlerFor(kind: LoginLimitKind, body: Record<string, unknown>, outcome?: Outcome) {
  return (): Observable<unknown> => {
    // El login de verdad: 401 igual exista o no la cuenta.
    const resultado: Outcome =
      outcome ??
      (kind === 'signin' &&
      CUENTAS_QUE_EXISTEN.has(String(body['email'])) &&
      body['password'] === 'bien'
        ? 'ok'
        : kind === 'forgot-password'
          ? 'ok'
          : 'credenciales');
    if (resultado === 'ok') return of({ ok: true });
    if (resultado === 'mfa') return throwError(() => new ForbiddenException({ code: 'X' }));
    if (resultado === 'servidor') return throwError(() => new InternalServerErrorException());
    return throwError(
      () =>
        new UnauthorizedException({
          code: 'AUTH_INVALID_CREDENTIALS',
          message: 'Credenciales inválidas',
        }),
    );
  };
}

interface Intento {
  status: number;
  body: unknown;
  retryAfter: string | undefined;
}

async function intento(
  interceptor: LoginLimitInterceptor,
  kind: LoginLimitKind | undefined,
  req: { ip?: string; host?: string; body?: Record<string, unknown>; user?: unknown },
  outcome?: Outcome,
): Promise<Intento> {
  const headers: Record<string, string> = {};
  const handler = () => undefined;
  if (kind) Reflect.defineMetadata(LOGIN_LIMIT_KEY, kind, handler);
  const request = {
    ip: req.ip ?? '203.0.113.7',
    headers: { host: req.host ?? 'aula.didacta.io' },
    hostname: req.host ?? 'aula.didacta.io',
    body: req.body ?? {},
    user: req.user,
  };
  const ctx = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: (k: string, v: string) => (headers[k] = v) }),
    }),
  } as unknown as ExecutionContext;
  try {
    await firstValueFrom(
      interceptor.intercept(ctx, { handle: handlerFor(kind ?? 'signin', request.body, outcome) }),
    );
    await new Promise((r) => setTimeout(r, 0)); // el descuento es asíncrono
    return { status: 200, body: { ok: true }, retryAfter: headers['Retry-After'] };
  } catch (err) {
    await new Promise((r) => setTimeout(r, 0));
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse(), retryAfter: headers['Retry-After'] };
  }
}

function nuevo(): LoginLimitInterceptor {
  return new LoginLimitInterceptor(new Reflector(), new LoginLimitService(redis));
}

describe('configuración', () => {
  it('defaults: 30 por IP en 1 min, 10 por cuenta en 15 min', () => {
    expect(resolveLoginLimitConfig()).toEqual({
      ipMax: 30,
      ipWindowSeconds: 60,
      accountMax: 10,
      accountWindowSeconds: 900,
    });
  });

  it('todo configurable por variable', () => {
    process.env['RATE_LIMIT_LOGIN_IP_MAX'] = '50';
    process.env['RATE_LIMIT_LOGIN_IP_WINDOW_SECONDS'] = '120';
    process.env['RATE_LIMIT_LOGIN_ACCOUNT_MAX'] = '5';
    process.env['RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS'] = '600';
    expect(resolveLoginLimitConfig()).toEqual({
      ipMax: 50,
      ipWindowSeconds: 120,
      accountMax: 5,
      accountWindowSeconds: 600,
    });
  });
});

describe('las rutas del acceso llevan el limitador', () => {
  it.each([
    [AuthController.prototype.signin, 'signin'],
    [AuthController.prototype.signup, 'signup'],
    [AuthController.prototype.forgotPassword, 'forgot-password'],
    [AuthController.prototype.resetPassword, 'reset-password'],
    [AuthController.prototype.resendResetLink, 'reset-resend'],
    [MfaController.prototype.verify, 'mfa'],
    [MfaController.prototype.enable, 'mfa'],
    [SupportAccessController.prototype.redeem, 'support-redeem'],
  ] as const)('%#: %s', (method, kind) => {
    expect(Reflect.getMetadata(LOGIN_LIMIT_KEY, method)).toBe(kind);
  });
});

describe('login: por cuenta', () => {
  it('10 fallos por correo → el 11.º es un 429 con Retry-After, aunque la contraseña sea buena', async () => {
    const i = nuevo();
    for (let n = 0; n < 10; n += 1) {
      const r = await intento(i, 'signin', {
        ip: `198.51.100.${n}`, // cada uno desde otra IP: el bloqueo es de la cuenta
        body: { email: 'ana@aula.test', password: 'mal' },
      });
      expect(r.status).toBe(401);
    }
    const bloqueado = await intento(i, 'signin', {
      ip: '198.51.100.99',
      body: { email: 'Ana@Aula.test ', password: 'bien' },
    });
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.retryAfter).toBe('900');
    expect(bloqueado.body).toEqual({
      statusCode: 429,
      error: 'TooManyRequests',
      code: 'AUTH_RATE_LIMITED',
      message: 'Demasiados intentos. Por seguridad, espera 15 min y vuelve a probar.',
      params: { minutes: '15' },
      retryAfterSeconds: 900,
    });

    // Pasada la ventana, vuelve a poder entrar.
    clock.now += 901_000;
    const despues = await intento(i, 'signin', {
      body: { email: 'ana@aula.test', password: 'bien' },
    });
    expect(despues.status).toBe(200);
  });

  it('no deja averiguar si el correo existe: la misma respuesta para uno que existe y otro que no', async () => {
    const i = nuevo();
    const tras10 = async (email: string) => {
      for (let n = 0; n < 10; n += 1) {
        await intento(i, 'signin', { ip: `192.0.2.${n}`, body: { email, password: 'mal' } });
      }
      return intento(i, 'signin', { ip: '192.0.2.200', body: { email, password: 'mal' } });
    };
    const existe = await tras10('ana@aula.test');
    const noExiste = await tras10('nadie@aula.test');
    expect(existe.status).toBe(429);
    expect(noExiste).toEqual(existe);
  });

  it('un login correcto no gasta cupo y pone a cero los fallos de la cuenta', async () => {
    const i = nuevo();
    for (let n = 0; n < 9; n += 1) {
      await intento(i, 'signin', { body: { email: 'ana@aula.test', password: 'mal' } });
    }
    expect(
      (await intento(i, 'signin', { body: { email: 'ana@aula.test', password: 'bien' } })).status,
    ).toBe(200);
    for (let n = 0; n < 10; n += 1) {
      expect(
        (await intento(i, 'signin', { body: { email: 'ana@aula.test', password: 'mal' } })).status,
      ).toBe(401);
    }
  });

  it('la cuenta es por aula: el mismo correo en otro dominio no está bloqueado', async () => {
    const i = nuevo();
    for (let n = 0; n < 10; n += 1) {
      await intento(i, 'signin', { ip: `192.0.2.${n}`, body: { email: 'ana@aula.test' } });
    }
    expect((await intento(i, 'signin', { body: { email: 'ana@aula.test' } })).status).toBe(429);
    expect(
      (await intento(i, 'signin', { host: 'otra.didacta.io', body: { email: 'ana@aula.test' } }))
        .status,
    ).toBe(401);
  });

  it('una ráfaga en paralelo no se cuela: de 25 intentos a la vez, solo 10 llegan al handler', async () => {
    const i = nuevo();
    const res = await Promise.all(
      Array.from({ length: 25 }, (_, n) =>
        intento(i, 'signin', { ip: `198.51.100.${n}`, body: { email: 'ana@aula.test' } }),
      ),
    );
    expect(res.filter((r) => r.status === 401)).toHaveLength(10);
    expect(res.filter((r) => r.status === 429)).toHaveLength(15);
  });

  it('un fallo del servidor no cuenta como intento', async () => {
    const i = nuevo();
    for (let n = 0; n < 20; n += 1) {
      await intento(i, 'signin', { body: { email: 'ana@aula.test' } }, 'servidor');
    }
    expect((await intento(i, 'signin', { body: { email: 'ana@aula.test' } })).status).toBe(401);
  });

  it('nada en claro en Redis: ni el correo ni la IP', async () => {
    const i = nuevo();
    await intento(i, 'signin', { body: { email: 'ana@aula.test' } });
    expect(redis.keys().join(' ')).not.toMatch(/ana|aula|203\.0\.113/);
  });
});

describe('por IP', () => {
  it('30 fallos desde una IP en un minuto → 429, aunque cada correo sea distinto', async () => {
    const i = nuevo();
    for (let n = 0; n < 30; n += 1) {
      expect((await intento(i, 'signin', { body: { email: `u${n}@aula.test` } })).status).toBe(401);
    }
    const r = await intento(i, 'signin', { body: { email: 'otra@aula.test' } });
    expect(r.status).toBe(429);
    expect(r.retryAfter).toBe('60');
    // Otra IP sigue pudiendo.
    expect(
      (await intento(i, 'signin', { ip: '198.51.100.1', body: { email: 'x@aula.test' } })).status,
    ).toBe(401);
    // Y pasado el minuto, la primera también.
    clock.now += 61_000;
    expect((await intento(i, 'signin', { body: { email: 'y@aula.test' } })).status).toBe(401);
  });

  it('una clase entera detrás de la misma IP entra: los logins correctos no gastan cupo', async () => {
    const i = nuevo();
    CUENTAS_QUE_EXISTEN.add('alumno@aula.test');
    for (let n = 0; n < 60; n += 1) {
      const r = await intento(i, 'signin', {
        body: { email: 'alumno@aula.test', password: 'bien' },
      });
      expect(r.status).toBe(200);
    }
  });

  it('con la IP agotada no se suman fallos a la cuenta de nadie', async () => {
    process.env['RATE_LIMIT_LOGIN_IP_MAX'] = '3';
    const i = nuevo();
    for (let n = 0; n < 50; n += 1) {
      await intento(i, 'signin', { body: { email: 'victima@aula.test' } });
    }
    // Desde otra IP, la víctima solo lleva 3 fallos: le quedan 7.
    for (let n = 0; n < 7; n += 1) {
      expect(
        (await intento(i, 'signin', { ip: `192.0.2.${n}`, body: { email: 'victima@aula.test' } }))
          .status,
      ).toBe(401);
    }
    expect(
      (await intento(i, 'signin', { ip: '192.0.2.100', body: { email: 'victima@aula.test' } }))
        .status,
    ).toBe(429);
  });
});

describe('el resto del acceso', () => {
  it('«olvidé mi contraseña» cuenta SIEMPRE (contesta 200 exista o no la cuenta)', async () => {
    const i = nuevo();
    for (let n = 0; n < 10; n += 1) {
      expect(
        (
          await intento(i, 'forgot-password', {
            ip: `192.0.2.${n}`,
            body: { email: 'nadie@aula.test' },
          })
        ).status,
      ).toBe(200);
    }
    const r = await intento(i, 'forgot-password', { body: { email: 'nadie@aula.test' } });
    expect(r.status).toBe(429);
    expect((r.body as { code: string }).code).toBe('AUTH_RATE_LIMITED');
  });

  it('MFA: la cuenta es el usuario de la sesión', async () => {
    const i = nuevo();
    const user = { sub: 'user-1', tenantId: 'aula-1' };
    for (let n = 0; n < 10; n += 1) {
      expect((await intento(i, 'mfa', { ip: `192.0.2.${n}`, user }, 'mfa')).status).toBe(403);
    }
    expect((await intento(i, 'mfa', { ip: '192.0.2.50', user }, 'ok')).status).toBe(429);
    // Otro usuario, sin bloqueo.
    expect((await intento(i, 'mfa', { user: { sub: 'user-2' } }, 'ok')).status).toBe(200);
  });

  it('una ruta sin marcar ni toca Redis', async () => {
    const i = nuevo();
    await intento(i, undefined, { body: { email: 'ana@aula.test' } });
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('failsafe: sin Redis, el acceso funciona', async () => {
    const i = new LoginLimitInterceptor(new Reflector(), new LoginLimitService(null));
    for (let n = 0; n < 40; n += 1) {
      expect((await intento(i, 'signin', { body: { email: 'ana@aula.test' } })).status).toBe(401);
    }
  });

  it('la clave de la cuenta: correo normalizado y por dominio; MFA por usuario', () => {
    const req = (email: unknown, host = 'Aula.Didacta.io') =>
      ({ body: { email }, headers: { host }, hostname: host }) as never;
    const p = LOGIN_LIMIT_POLICIES.signin;
    expect(loginAccountKey(p, req(' ANA@aula.test '))).toBe(
      loginAccountKey(p, req('ana@aula.test')),
    );
    expect(loginAccountKey(p, req('ana@aula.test'))).not.toBe(
      loginAccountKey(p, req('ana@aula.test', 'otra.didacta.io')),
    );
    // El puerto no cambia la cuenta (proxy vs. salto interno al mismo aula).
    expect(loginAccountKey(p, req('ana@aula.test', 'aula.didacta.io:3000'))).toBe(
      loginAccountKey(p, req('ana@aula.test', 'aula.didacta.io')),
    );
    expect(loginAccountKey(p, req(42))).toBeNull();
    expect(loginAccountKey(LOGIN_LIMIT_POLICIES.mfa, { user: { sub: 'u1' } } as never)).toBe(
      'user:u1',
    );
  });
});
