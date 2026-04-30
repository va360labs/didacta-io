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

import { OidcCallbackHandler } from './oidc-callback-handler';

export const metadata = {
  title: 'Iniciando sesión…',
};

export default function OidcCallbackPage() {
  return <OidcCallbackHandler />;
}
