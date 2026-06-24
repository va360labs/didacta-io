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
});
