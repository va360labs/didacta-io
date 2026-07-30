import { sessionRegistryStub } from './helpers/session-registry-stub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth/auth.service';

const dummy = (..._args: unknown[]): AuthService =>
  new AuthService(null as never, null as never, null as never, null as never, null as never);

const ENV = 'DIDACTA_REQUIRE_MFA_ADMIN';

describe('AuthService.shouldRequireMfa', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  const service = dummy();

  it('default (env no seteada): NO exige MFA a admins — opt-in del operador', () => {
    expect(service.shouldRequireMfa(['super_admin'], false)).toBe(false);
    expect(service.shouldRequireMfa(['tenant_admin'], false)).toBe(false);
    expect(service.shouldRequireMfa(['tenant_admin'], true)).toBe(false);
  });

  it('NO exige MFA a alumno (sea cual sea el flag)', () => {
    expect(service.shouldRequireMfa(['alumno'], false)).toBe(false);
    process.env[ENV] = 'true';
    expect(service.shouldRequireMfa(['alumno'], false)).toBe(false);
  });

  it('NO exige MFA a formador (sea cual sea el flag)', () => {
    expect(service.shouldRequireMfa(['formador'], false)).toBe(false);
    process.env[ENV] = 'true';
    expect(service.shouldRequireMfa(['formador'], false)).toBe(false);
  });

  it('NO exige MFA si no hay roles', () => {
    expect(service.shouldRequireMfa([], false)).toBe(false);
    process.env[ENV] = 'true';
    expect(service.shouldRequireMfa([], false)).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on'])(
    'DIDACTA_REQUIRE_MFA_ADMIN=%s activa la enforcement automática',
    (value) => {
      process.env[ENV] = value;
      expect(service.shouldRequireMfa(['super_admin'], false)).toBe(true);
      expect(service.shouldRequireMfa(['tenant_admin'], false)).toBe(true);
      expect(service.shouldRequireMfa(['tenant_admin'], true)).toBe(true);
    },
  );

  it.each(['false', '0', '', 'maybe', 'no'])(
    'DIDACTA_REQUIRE_MFA_ADMIN=%s mantiene el default (no exige)',
    (value) => {
      process.env[ENV] = value;
      expect(service.shouldRequireMfa(['super_admin'], false)).toBe(false);
    },
  );
});

/**
 * Registro público CERRADO por defecto. El signup abierto creaba usuarios
 * ACTIVE sin rol (JWT roles:[] → 403 en storage etc.); ahora está tras
 * AUTH_SIGNUP_ENABLED (solo dev/E2E) y, cuando está abierto, asigna `alumno`.
 */
describe('AuthService.signup · gate AUTH_SIGNUP_ENABLED', () => {
  const FLAG = 'AUTH_SIGNUP_ENABLED';
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[FLAG];
    delete process.env[FLAG];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  const dto = { email: 'x@y.com', password: 'Password123!', tenantSlug: 'va360' };

  it('sin la env (default) → 403 sin tocar la BD', async () => {
    // prisma null: si el gate no cortara ANTES de resolver tenant, esto
    // explotaría con TypeError en vez de ForbiddenException.
    await expect(dummy().signup(dto)).rejects.toMatchObject({ status: 403 });
  });

  it.each(['false', '1', 'yes', 'TRUE'])('AUTH_SIGNUP_ENABLED=%s (≠ "true") → 403', async (v) => {
    process.env[FLAG] = v;
    await expect(dummy().signup(dto)).rejects.toMatchObject({ status: 403 });
  });

  it('AUTH_SIGNUP_ENABLED=true deja pasar el gate (y crea el usuario CON rol alumno)', async () => {
    process.env[FLAG] = 'true';
    const TENANT = { id: 't1', slug: 'va360', name: 'VA360', status: 'ACTIVE' };
    const ALUMNO = { id: 'r1', name: 'alumno' };
    const created = {
      id: 'u1',
      email: dto.email,
      name: null,
      avatarUrl: null,
      mfaEnabled: false,
      mustChangePassword: false,
      onboardingCompletedAt: null,
      roles: [],
      tenant: TENANT,
    };
    const userRoleCreate = vi.fn(async (args: unknown) => args);
    const prisma = {
      tenant: { findUnique: async () => TENANT, findMany: async () => [TENANT] },
      user: { findUnique: async () => null },
      role: {
        findUnique: async (args: { where: { name: string } }) =>
          args.where.name === 'alumno' ? ALUMNO : null,
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          user: { create: async () => created },
          userRole: { create: userRoleCreate },
        }),
    };
    const service = new AuthService(
      prisma as never,
      { hash: async () => 'hashed' } as never,
      { sign: async () => ({ accessToken: 'a', refreshToken: 'r' }) } as never,
      { record: async () => {} } as never,
      { evaluateLoginPolicy: async () => ({ outcome: 'allow' }) } as never,
      sessionRegistryStub({ sign: async () => ({ accessToken: 'a', refreshToken: 'r' }) } as never),
    );

    const result = await service.signup(dto);

    // El fix del bug de usuarios sin rol: el alta asigna alumno SIEMPRE.
    expect(userRoleCreate).toHaveBeenCalledWith({ data: { userId: 'u1', roleId: 'r1' } });
    expect(result.user.roles).toEqual(['alumno']);
  });
});
