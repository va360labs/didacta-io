/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Página de error OIDC (8º piloto License SDK, `feat:sso.oidc`).
 *
 * El backend redirige aquí cuando algo falla en el flow:
 *
 *   ${WEB_PUBLIC_URL}/auth/error?reason=<reason>
 *
 * Razones documentadas (ver `mapErrorToReason` en oidc.controller.ts):
 *   - state_invalid          → state no encontrado o consumido
 *   - state_expired          → flow inició hace >10min sin completarse
 *   - idp_error              → el IdP devolvió error en el redirect
 *   - iss_mismatch           → iss del id_token no coincide con la config
 *   - aud_mismatch           → aud no incluye nuestro clientId
 *   - nonce_mismatch         → nonce del id_token != nonce del flow
 *   - email_not_allowed      → email fuera de allowedEmailDomains
 *   - user_not_provisioned   → user no existe y autoProvision=false
 *   - user_inactive          → user existe pero status != ACTIVE
 *   - tenant_not_configured  → tenant sin OIDC enabled
 *   - idp_unreachable        → discovery falló
 *   - config_changed         → admin tocó la config a mitad de flow
 *   - bad_request            → faltan state/code en el callback
 *   - missing_tokens         → llegamos a /auth/callback sin params
 *   - me_failed              → /me falló tras setear tokens
 *   - internal               → fallo no clasificado
 */

import { Suspense } from 'react';
import { OidcErrorContent } from './oidc-error-content';

export const metadata = {
  title: 'Error de inicio de sesión',
};

// Next 15 exige envolver páginas que usan `useSearchParams()` en <Suspense>
// cuando hay static generation (router App + export). Sin esto, el build de
// producción falla con "missing-suspense-with-csr-bailout" en /auth/error.
export default function OidcErrorPage() {
  return (
    <Suspense fallback={null}>
      <OidcErrorContent />
    </Suspense>
  );
}
