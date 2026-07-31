import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import {
  JwtAuthGuard,
  MFA_EXEMPT_KEY,
  PUBLIC_ROUTE_KEY,
  REQUIRES_MFA_KEY,
} from '../src/auth/jwt-auth.guard';
import { TokenService } from '../src/auth/token.service';

const ORIGINAL = process.env['AUTH_SECRET'];
const ORIGINAL_MFA = process.env['DIDACTA_REQUIRE_MFA_ADMIN'];

beforeAll(() => {
  process.env['AUTH_SECRET'] = 'a'.repeat(64);
  process.env['AUTH_URL'] = 'https://didacta.test';
  // Este archivo prueba el enforcement de MFA para admins. El default cambió a
  // opt-in (commit 4c1b5aa), así que lo activamos explícitamente.
  process.env['DIDACTA_REQUIRE_MFA_ADMIN'] = 'true';
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env['AUTH_SECRET'];
  else process.env['AUTH_SECRET'] = ORIGINAL;
  if (ORIGINAL_MFA === undefined) delete process.env['DIDACTA_REQUIRE_MFA_ADMIN'];
  else process.env['DIDACTA_REQUIRE_MFA_ADMIN'] = ORIGINAL_MFA;
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

  describe('Enforcement automático para roles admin (LMS-109)', () => {
    it('tenant_admin con mfaVerified=false en ruta NO exenta → ForbiddenException con code=mfa_required', async () => {
      const tokens = new TokenService();
      const signed = await tokens.sign({
        sub: 'admin-1',
        tenantId: 't-1',
        roles: ['tenant_admin'],
        mfaVerified: false,
      });
      const { ctx, reflector } = makeContext({ authorization: `Bearer ${signed.accessToken}` });
      const guard = new JwtAuthGuard(tokens, reflector);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
      // Comprobamos también el shape — el cliente web depende de este code
      // para disparar el redirect a /mfa/setup o /mfa/verify.
      try {
        await guard.canActivate(ctx);
      } catch (e) {
        const fb = e as ForbiddenException;
        const response = fb.getResponse() as { code?: string; message?: string };
        expect(response.code).toBe('mfa_required');
      }
    });

    it('super_admin con mfaVerified=false en ruta NO exenta → 403 con mfa_required', async () => {
      const tokens = new TokenService();
      const signed = await tokens.sign({
        sub: 'super-1',
        tenantId: 't-1',
        roles: ['super_admin'],
        mfaVerified: false,
      });
      const { ctx, reflector } = makeContext({ authorization: `Bearer ${signed.accessToken}` });
      const guard = new JwtAuthGuard(tokens, reflector);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin con mfaVerified=true → pasa', async () => {
      const tokens = new TokenService();
      const signed = await tokens.sign({
        sub: 'admin-2',
        tenantId: 't-1',
        roles: ['tenant_admin'],
        mfaVerified: true,
      });
      const { ctx, reflector } = makeContext({ authorization: `Bearer ${signed.accessToken}` });
      const guard = new JwtAuthGuard(tokens, reflector);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('admin con mfaVerified=false en ruta @MfaExempt() → pasa (para poder completar el setup)', async () => {
      const tokens = new TokenService();
      const signed = await tokens.sign({
        sub: 'admin-3',
        tenantId: 't-1',
        roles: ['tenant_admin'],
        mfaVerified: false,
      });
      const { ctx, reflector } = makeContext(
        { authorization: `Bearer ${signed.accessToken}` },
        { [MFA_EXEMPT_KEY]: true },
      );
      const guard = new JwtAuthGuard(tokens, reflector);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('alumno con mfaVerified=false → pasa (no aplica el enforcement automático)', async () => {
      const tokens = new TokenService();
      const signed = await tokens.sign({
        sub: 'alumno-1',
        tenantId: 't-1',
        roles: ['alumno'],
        mfaVerified: false,
      });
      const { ctx, reflector } = makeContext({ authorization: `Bearer ${signed.accessToken}` });
      const guard = new JwtAuthGuard(tokens, reflector);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('formador con mfaVerified=false → pasa (no aplica)', async () => {
      const tokens = new TokenService();
      const signed = await tokens.sign({
        sub: 'formador-1',
        tenantId: 't-1',
        roles: ['formador'],
        mfaVerified: false,
      });
      const { ctx, reflector } = makeContext({ authorization: `Bearer ${signed.accessToken}` });
      const guard = new JwtAuthGuard(tokens, reflector);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('admin con múltiples roles + mfaVerified=false → 403 (cualquier rol admin activa el enforcement)', async () => {
      const tokens = new TokenService();
      const signed = await tokens.sign({
        sub: 'admin-multi',
        tenantId: 't-1',
        roles: ['formador', 'tenant_admin'],
        mfaVerified: false,
      });
      const { ctx, reflector } = makeContext({ authorization: `Bearer ${signed.accessToken}` });
      const guard = new JwtAuthGuard(tokens, reflector);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
