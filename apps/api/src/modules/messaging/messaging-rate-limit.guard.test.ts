import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import {
  MESSAGING_RATE_LIMITED,
  MessagingRateLimitGuard,
  type MessagingRateLimitOptions,
} from './messaging-rate-limit.guard';

/**
 * Cupo de mensajería (ADR-019 §3). Sin Redis en test, se ejercita el contador
 * en memoria — el mismo que protege si Redis se cae en producción.
 */

function contextFor(user: { sub: string; tenantId: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function guardWith(options: MessagingRateLimitOptions | undefined): MessagingRateLimitGuard {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(options);
  const guard = new MessagingRateLimitGuard(reflector);
  guard.onModuleInit();
  return guard;
}

const USER = { sub: 'u1', tenantId: 't1' };

describe('MessagingRateLimitGuard', () => {
  it('deja pasar los endpoints sin cupo declarado', async () => {
    const guard = guardWith(undefined);
    expect(await guard.canActivate(contextFor(USER))).toBe(true);
  });

  it('permite hasta el límite y rechaza el siguiente con código estable', async () => {
    const guard = guardWith({ bucket: 'typing', limit: 3, windowSec: 60 });
    const ctx = contextFor(USER);

    for (let i = 0; i < 3; i += 1) {
      expect(await guard.canActivate(ctx)).toBe(true);
    }

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
    try {
      await guard.canActivate(ctx);
      expect.unreachable('debería haber lanzado');
    } catch (e) {
      const response = (e as HttpException).getResponse() as { code?: string };
      expect((e as HttpException).getStatus()).toBe(429);
      expect(response.code).toBe(MESSAGING_RATE_LIMITED);
    }
  });

  it('el cupo es por usuario: el de al lado no se ve penalizado', async () => {
    const guard = guardWith({ bucket: 'typing', limit: 1, windowSec: 60 });

    expect(await guard.canActivate(contextFor(USER))).toBe(true);
    await expect(guard.canActivate(contextFor(USER))).rejects.toBeInstanceOf(HttpException);
    expect(await guard.canActivate(contextFor({ sub: 'u2', tenantId: 't1' }))).toBe(true);
  });

  it('el mismo usuario en otro tenant tiene su propio contador', async () => {
    const guard = guardWith({ bucket: 'send', limit: 1, windowSec: 60 });

    expect(await guard.canActivate(contextFor(USER))).toBe(true);
    expect(await guard.canActivate(contextFor({ sub: 'u1', tenantId: 't2' }))).toBe(true);
  });

  it('la ventana se reabre al vencer', async () => {
    vi.useFakeTimers();
    try {
      const guard = guardWith({ bucket: 'typing', limit: 1, windowSec: 60 });
      const ctx = contextFor(USER);

      expect(await guard.canActivate(ctx)).toBe(true);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);

      vi.advanceTimersByTime(61_000);
      expect(await guard.canActivate(ctx)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sin identidad resuelta no aplica cupo (decide JwtAuthGuard)', async () => {
    const guard = guardWith({ bucket: 'typing', limit: 1, windowSec: 60 });
    expect(await guard.canActivate(contextFor(undefined))).toBe(true);
    expect(await guard.canActivate(contextFor(undefined))).toBe(true);
  });
});
