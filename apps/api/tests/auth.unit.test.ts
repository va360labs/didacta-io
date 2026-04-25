import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/auth.service';

const dummy = (..._args: unknown[]): AuthService =>
  new AuthService(null as never, null as never, null as never);

describe('AuthService.shouldRequireMfa', () => {
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
});
