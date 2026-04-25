import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenService } from '../src/auth/token.service';

const ORIGINAL = process.env['AUTH_SECRET'];

beforeAll(() => {
  process.env['AUTH_SECRET'] = 'a'.repeat(64);
  process.env['AUTH_URL'] = 'https://learnship.test';
});

afterAll(() => {
  if (ORIGINAL === undefined) {
    delete process.env['AUTH_SECRET'];
  } else {
    process.env['AUTH_SECRET'] = ORIGINAL;
  }
});

describe('TokenService', () => {
  it('firma y verifica un access token con tenantId y roles', async () => {
    const service = new TokenService();
    const tokens = await service.sign({
      sub: 'user-1',
      tenantId: 'tenant-1',
      roles: ['alumno'],
      mfaVerified: true,
    });
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresIn).toBeGreaterThan(0);

    const claims = await service.verifyAccess(tokens.accessToken);
    expect(claims.sub).toBe('user-1');
    expect(claims.tenantId).toBe('tenant-1');
    expect(claims.roles).toEqual(['alumno']);
    expect(claims.mfaVerified).toBe(true);
  });

  it('verifyAccess rechaza un refresh token', async () => {
    const service = new TokenService();
    const { refreshToken } = await service.sign({
      sub: 'user-1',
      tenantId: 'tenant-1',
      roles: [],
      mfaVerified: false,
    });
    await expect(service.verifyAccess(refreshToken)).rejects.toThrow();
  });

  it('verifyRefresh acepta refresh y rechaza access', async () => {
    const service = new TokenService();
    const tokens = await service.sign({
      sub: 'user-2',
      tenantId: 'tenant-2',
      roles: ['formador'],
      mfaVerified: false,
    });
    const refreshClaims = await service.verifyRefresh(tokens.refreshToken);
    expect(refreshClaims.sub).toBe('user-2');
    expect(refreshClaims.tenantId).toBe('tenant-2');
    await expect(service.verifyRefresh(tokens.accessToken)).rejects.toThrow();
  });
});
