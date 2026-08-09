/**
 * Tests de `ApiScopeGuard` (enforcement de scopes de API key).
 *
 * El guard corre DESPUÉS de JwtOrApiKeyGuard, que para una API key mapea sus
 * `scopes` dentro de `request.user.roles`. El guard exige que todos los scopes
 * declarados con `@RequireApiScopes(...)` estén presentes.
 */

import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ApiScopeGuard } from '../src/auth/api-scope.guard';

function makeCtx(user: unknown): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function makeGuard(required: string[]) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(required) } as never;
  return new ApiScopeGuard(reflector);
}

describe('ApiScopeGuard', () => {
  it('permite cuando no hay scopes requeridos (aunque no haya user)', () => {
    const guard = makeGuard([]);
    expect(guard.canActivate(makeCtx(undefined))).toBe(true);
  });

  it('permite cuando la key tiene el scope requerido', () => {
    const guard = makeGuard(['enrollments:write']);
    const ctx = makeCtx({
      sub: 'u',
      tenantId: 't',
      roles: ['enrollments:write'],
      mfaVerified: true,
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rechaza con 403 cuando falta el scope', () => {
    const guard = makeGuard(['enrollments:write']);
    const ctx = makeCtx({ sub: 'u', tenantId: 't', roles: ['otra:cosa'], mfaVerified: true });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rechaza con 401 cuando no hay user pero sí scopes requeridos', () => {
    const guard = makeGuard(['enrollments:write']);
    expect(() => guard.canActivate(makeCtx(undefined))).toThrow(UnauthorizedException);
  });

  it('los scopes que faltan viajan en `detail`, no solo dentro del message', () => {
    // El catálogo inglés decía «The API key does not have the required
    // scope(s).» y se tragaba CUÁLES: sin la lista, quien integra por API no
    // sabe qué marcar al regenerar la key. Ahora la lista va en `detail` y cada
    // idioma la enmarca; el `message` español no cambia.
    const guard = makeGuard(['courses:write', 'users:read']);
    const ctx = makeCtx({ sub: 'u', tenantId: 't', roles: ['courses:write'], mfaVerified: true });
    try {
      guard.canActivate(ctx);
    } catch (err) {
      const body = (err as { response: { message: string; code: string; detail?: string } })
        .response;
      expect(body.code).toBe('AUTH_API_KEY_MISSING_SCOPES');
      expect(body.message).toBe('La API key no tiene el/los scope(s) requerido(s): users:read');
      expect(body.detail).toBe('users:read');
      return;
    }
    throw new Error('no lanzó');
  });
});
