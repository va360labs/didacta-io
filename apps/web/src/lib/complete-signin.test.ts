/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it, vi } from 'vitest';
import { postSignInPath } from './complete-signin';

/**
 * Adónde va quien acaba de entrar con contraseña. Lo usa también la pantalla
 * de «elige tu contraseña», que ahora entra sola (ensayo general, 14-nov).
 */
describe('postSignInPath', () => {
  const base = {
    mfaRequired: false,
    user: { mfaEnabled: false, onboardingCompletedAt: '2026-11-14' },
  };

  it('primer acceso (perfil sin hacer) → /onboarding, SIN consumir el destino pendiente', () => {
    const consume = vi.fn(() => '/courses/torno');
    expect(
      postSignInPath({ ...base, user: { ...base.user, onboardingCompletedAt: null } }, consume),
    ).toBe('/onboarding');
    // Lo consume el perfil al terminar: así el alumno acaba en su curso.
    expect(consume).not.toHaveBeenCalled();
  });

  it('con perfil hecho → el destino pendiente (el curso comprado)', () => {
    expect(postSignInPath(base, () => '/courses/torno')).toBe('/courses/torno');
  });

  it('sin destino pendiente → /home', () => {
    expect(postSignInPath(base, () => null)).toBe('/home');
  });

  it('segundo factor pendiente → MFA antes que nada', () => {
    const consume = vi.fn(() => '/courses/torno');
    expect(
      postSignInPath(
        { ...base, mfaRequired: true, user: { ...base.user, mfaEnabled: true } },
        consume,
      ),
    ).toBe('/mfa/verify');
    expect(postSignInPath({ ...base, mfaRequired: true }, consume)).toBe('/mfa/setup');
    expect(consume).not.toHaveBeenCalled();
  });
});
