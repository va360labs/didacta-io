import { ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RestrictionInterceptor } from './restriction.interceptor';
import type { ActiveRestriction } from './restriction.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '33333333-3333-3333-3333-333333333333';

function ctx(method: string, url: string, user: unknown = { sub: USER, tenantId: TENANT }) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, url, user }) }),
  } as never;
}

function setup(active: ActiveRestriction[] = []) {
  const service = { activeRestrictions: vi.fn().mockResolvedValue(active) };
  const interceptor = new RestrictionInterceptor(service as never);
  const next = { handle: vi.fn().mockReturnValue(of('ok')) };
  return { interceptor, service, next };
}

const spamCommunity: ActiveRestriction = {
  id: 'r1',
  scopes: ['community'],
  reason: 'Spam repetido en el feed',
  expiresAt: null,
};

describe('RestrictionInterceptor — cuándo ni consulta', () => {
  it('las lecturas no tocan la caché: es el 90 % del tráfico', async () => {
    const { interceptor, service, next } = setup([spamCommunity]);
    await interceptor.intercept(ctx('GET', '/api/v1/modules/community/posts'), next as never);
    expect(service.activeRestrictions).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalled();
  });

  it('sin usuario (ruta pública) deja pasar', async () => {
    const { interceptor, service, next } = setup([spamCommunity]);
    await interceptor.intercept(
      ctx('POST', '/api/v1/modules/community/posts', null),
      next as never,
    );
    expect(service.activeRestrictions).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalled();
  });

  it('no rompe fuera de HTTP (jobs, websockets)', async () => {
    const { interceptor, service, next } = setup([spamCommunity]);
    const nonHttp = { getType: () => 'ws' } as never;
    await interceptor.intercept(nonHttp, next as never);
    expect(service.activeRestrictions).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalled();
  });
});

describe('RestrictionInterceptor — bloqueo', () => {
  it('corta la publicación de un sancionado en comunidad', async () => {
    const { interceptor, next } = setup([spamCommunity]);
    await expect(
      interceptor.intercept(ctx('POST', '/api/v1/modules/community/posts'), next as never),
    ).rejects.toThrow(ForbiddenException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('el 403 lleva código, área, motivo y vencimiento', async () => {
    const { interceptor, next } = setup([spamCommunity]);
    try {
      await interceptor.intercept(ctx('POST', '/api/v1/modules/community/posts'), next as never);
      expect.unreachable('debía lanzar');
    } catch (err) {
      const body = (err as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('user_restricted');
      expect(body.area).toBe('Comunidad');
      expect(body.reason).toBe('Spam repetido en el feed');
      expect(body.expiresAt).toBeNull();
      expect(String(body.message)).toContain('Spam repetido en el feed');
      expect(String(body.message)).toContain('permanente');
    }
  });

  it('una sanción temporal dice hasta cuándo dura', async () => {
    const { interceptor, next } = setup([
      { ...spamCommunity, expiresAt: '2026-08-15T18:30:00.000Z' },
    ]);
    try {
      await interceptor.intercept(ctx('POST', '/api/v1/modules/community/posts'), next as never);
      expect.unreachable('debía lanzar');
    } catch (err) {
      const body = (err as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(String(body.message)).toContain('hasta el');
      expect(String(body.message)).toContain('15/08/2026');
    }
  });

  it('deja pasar lo que la sanción no cubre', async () => {
    const { interceptor, next } = setup([spamCommunity]);
    await interceptor.intercept(
      ctx('POST', '/api/v1/modules/messaging/conversations/abc/messages'),
      next as never,
    );
    expect(next.handle).toHaveBeenCalled();
  });

  it('sin sanciones activas no bloquea', async () => {
    const { interceptor, next } = setup([]);
    await interceptor.intercept(ctx('POST', '/api/v1/modules/community/posts'), next as never);
    expect(next.handle).toHaveBeenCalled();
  });

  it('con dos sanciones, reporta la que realmente bloquea', async () => {
    const { interceptor, next } = setup([
      spamCommunity,
      { id: 'r2', scopes: ['ai'], reason: 'Quemó la cuota del tutor', expiresAt: null },
    ]);
    try {
      await interceptor.intercept(
        ctx('POST', '/api/v1/modules/ai-tutor/courses/abc/ask'),
        next as never,
      );
      expect.unreachable('debía lanzar');
    } catch (err) {
      const body = (err as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(body.area).toBe('Tutor IA');
      expect(body.reason).toBe('Quemó la cuota del tutor');
    }
  });

  it('nunca corta un pago, ni con sanción total', async () => {
    const { interceptor, next } = setup([
      { id: 'r3', scopes: ['all'], reason: 'Acoso', expiresAt: null },
    ]);
    await interceptor.intercept(ctx('POST', '/api/v1/modules/billing/checkout'), next as never);
    expect(next.handle).toHaveBeenCalled();
  });

  it('nunca corta el progreso del curso que ya compró', async () => {
    const { interceptor, next } = setup([
      { id: 'r3', scopes: ['all'], reason: 'Acoso', expiresAt: null },
    ]);
    await interceptor.intercept(ctx('POST', '/api/v1/modules/learning/progress'), next as never);
    expect(next.handle).toHaveBeenCalled();
  });

  it('cubre la API externa, que no pasa por JwtAuthGuard', async () => {
    const { interceptor, next } = setup([spamCommunity]);
    await expect(
      interceptor.intercept(ctx('POST', '/api/v1/community-api/posts'), next as never),
    ).rejects.toThrow(ForbiddenException);
  });
});
