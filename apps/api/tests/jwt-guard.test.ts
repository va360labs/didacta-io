import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard, PUBLIC_ROUTE_KEY, REQUIRES_MFA_KEY } from '../src/auth/jwt-auth.guard';
import { TokenService } from '../src/auth/token.service';

const ORIGINAL = process.env['AUTH_SECRET'];

beforeAll(() => {
  process.env['AUTH_SECRET'] = 'a'.repeat(64);
  process.env['AUTH_URL'] = 'https://learnship.test';
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env['AUTH_SECRET'];
  else process.env['AUTH_SECRET'] = ORIGINAL;
});

function makeContext(headers: Record<string, string>, metadata: Record<string, unknown> = {}) {
  const request = { headers } as { headers: Record<string, string>; user?: unknown };
  const reflector = new Reflector();
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({ __metadata: metadata }),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  // monkey-patch reflector to read from metadata map
  (
    reflector as unknown as { getAllAndOverride: typeof reflector.getAllAndOverride }
  ).getAllAndOverride = (key: unknown) => {
    return metadata[key as string] as never;
  };
  return { ctx, request, reflector };
}

describe('JwtAuthGuard', () => {
  it('rechaza request sin Authorization', async () => {
    const tokens = new TokenService();
    const { ctx, reflector } = makeContext({});
    const guard = new JwtAuthGuard(tokens, reflector);
    await expect(guard.canActivate(ctx)).rejects.toThrow(/Authorization/);
  });

  it('acepta request con Bearer válido y popula request.user', async () => {
    const tokens = new TokenService();
    const signed = await tokens.sign({
      sub: 'u-1',
      tenantId: 't-1',
      roles: ['alumno'],
      mfaVerified: false,
    });
    const { ctx, request, reflector } = makeContext({
      authorization: `Bearer ${signed.accessToken}`,
    });
    const guard = new JwtAuthGuard(tokens, reflector);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toMatchObject({ sub: 'u-1', tenantId: 't-1' });
  });

  it('rechaza si requiresMfa=true y mfaVerified=false', async () => {
    const tokens = new TokenService();
    const signed = await tokens.sign({
      sub: 'u-2',
      tenantId: 't-2',
      roles: ['tenant_admin'],
      mfaVerified: false,
    });
    const { ctx, reflector } = makeContext(
      { authorization: `Bearer ${signed.accessToken}` },
      { [REQUIRES_MFA_KEY]: true },
    );
    const guard = new JwtAuthGuard(tokens, reflector);
    await expect(guard.canActivate(ctx)).rejects.toThrow(/MFA/);
  });

  it('skip auth si la ruta es @Public()', async () => {
    const tokens = new TokenService();
    const { ctx, reflector } = makeContext({}, { [PUBLIC_ROUTE_KEY]: true });
    const guard = new JwtAuthGuard(tokens, reflector);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
