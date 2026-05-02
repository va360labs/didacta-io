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

  it('exige MFA a super_admin sin MFA configurado', () => {
    expect(service.shouldRequireMfa(['super_admin'], false)).toBe(true);
  });

  it('exige MFA a tenant_admin sin MFA configurado', () => {
    expect(service.shouldRequireMfa(['tenant_admin'], false)).toBe(true);
  });

  it('exige MFA a admin aun con mfaEnabled=true (segundo factor en runtime)', () => {
    expect(service.shouldRequireMfa(['tenant_admin'], true)).toBe(true);
  });

  it('NO exige MFA a alumno', () => {
    expect(service.shouldRequireMfa(['alumno'], false)).toBe(false);
  });

  it('NO exige MFA a formador', () => {
    expect(service.shouldRequireMfa(['formador'], false)).toBe(false);
  });

  it('NO exige MFA si no hay roles', () => {
    expect(service.shouldRequireMfa([], false)).toBe(false);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off'])(
    'DIDACTA_REQUIRE_MFA_ADMIN=%s desactiva la enforcement automática',
    (value) => {
      process.env[ENV] = value;
      expect(service.shouldRequireMfa(['super_admin'], false)).toBe(false);
      expect(service.shouldRequireMfa(['tenant_admin'], false)).toBe(false);
    },
  );

  it('valor "true" (o cualquier otro) mantiene la enforcement', () => {
    process.env[ENV] = 'true';
    expect(service.shouldRequireMfa(['super_admin'], false)).toBe(true);
    process.env[ENV] = 'maybe';
    expect(service.shouldRequireMfa(['super_admin'], false)).toBe(true);
    process.env[ENV] = '';
    expect(service.shouldRequireMfa(['super_admin'], false)).toBe(true);
  });
});
