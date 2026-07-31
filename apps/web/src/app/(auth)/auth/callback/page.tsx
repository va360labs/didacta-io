/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Página de callback OIDC (8º piloto License SDK, `feat:sso.oidc`).
 *
 * El backend, tras validar el id_token y emitir tokens internos, hace
 * redirect 302 a:
 *
 *   ${WEB_PUBLIC_URL}/auth/callback?accessToken=...&refreshToken=...&expiresIn=...&tenantSlug=...
 *
 * Esta página lee los query params, los guarda igual que el flow
 * password-based (sessionStorage + localStorage vía authStorage) y redirige
 * al `/`. Si faltan params, redirige a /auth/error.
 */

import { Suspense } from 'react';
import { OidcCallbackHandler } from './oidc-callback-handler';

export const metadata = {
  title: 'Iniciando sesión…',
};

// Next 15 exige envolver páginas que usan `useSearchParams()` en <Suspense>
// cuando hay static generation. Sin esto, el build de producción falla con
// "missing-suspense-with-csr-bailout" en /auth/callback.
export default function OidcCallbackPage() {
  return (
    <Suspense fallback={null}>
      <OidcCallbackHandler />
    </Suspense>
  );
}
