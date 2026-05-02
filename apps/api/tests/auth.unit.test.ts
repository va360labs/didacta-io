import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
