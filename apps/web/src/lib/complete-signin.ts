/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import { consumeIntendedPath } from './post-login-redirect';
import { invalidateCommunitySpacesCache } from '@/modules/community';
import { requestThemeRefresh } from './theming';

/** Respuesta de `POST /auth/signin`. */
export interface SignInResponse {
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
  mfaRequired: boolean;
  user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl?: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
    mustChangePassword?: boolean;
    onboardingCompletedAt?: string | null;
  };
}

/**
 * Adónde va alguien que acaba de autenticarse con contraseña. Pura (ver
 * `complete-signin.test.ts`):
 *
 *  - con el segundo factor pendiente, a verificarlo (o a configurarlo);
 *  - con el primer acceso sin hacer, al perfil (`/onboarding`), que es quien
 *    consume después el destino pendiente;
 *  - si no, al destino pendiente (deep link, el curso que acaba de comprar…)
 *    o a `/home`.
 *
 * El destino pendiente NO se consume en los dos primeros casos: lo hará quien
 * cierre el último paso.
 */
export function postSignInPath(
  response: Pick<SignInResponse, 'mfaRequired'> & {
    user: Pick<SignInResponse['user'], 'mfaEnabled' | 'onboardingCompletedAt'>;
  },
  consumePending: () => string | null,
): string {
  if (response.mfaRequired) return response.user.mfaEnabled ? '/mfa/verify' : '/mfa/setup';
  if (response.user.onboardingCompletedAt === null) return '/onboarding';
  return consumePending() ?? '/home';
}

/**
 * Guarda la sesión recién abierta y devuelve adónde navegar. Lo comparten el
 * formulario de acceso y la pantalla de «elige tu contraseña», que entra sola
 * con la contraseña recién guardada en vez de mandar a un «Bienvenido de
 * nuevo» con el correo en blanco.
 *
 * `remember`: marcado → localStorage (sobrevive al cierre del navegador);
 * desmarcado → sessionStorage (muere con la pestaña). Ver `auth-storage.ts`.
 */
export function completeSignIn(response: SignInResponse, remember: boolean): string {
  authStorage.saveTokens(response.tokens.accessToken, response.tokens.refreshToken, remember);
  authStorage.saveSession({ user: response.user, mfaRequired: response.mfaRequired }, remember);
  // Arranca el sidebar de espacios desde cero con el token ya válido (evita
  // arrastrar un cache vacío o de otro tenant entre navegaciones SPA).
  invalidateCommunitySpacesCache();
  // El TenantThemeProvider (root layout) no se re-monta en la navegación SPA
  // post-login, así que pedimos que recoja el branding (logo) ahora mismo.
  requestThemeRefresh();
  return postSignInPath(response, consumeIntendedPath);
}

/** `POST /auth/signin` tal cual; los errores salen como `ApiHttpError`. */
export function signInWithPassword(input: {
  tenantSlug?: string;
  email: string;
  password: string;
}): Promise<SignInResponse> {
  return apiFetch<SignInResponse>('/api/v1/auth/signin', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
