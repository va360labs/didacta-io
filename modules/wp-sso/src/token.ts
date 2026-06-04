import { errors as joseErrors, jwtVerify } from 'jose';
import { WpSsoTokenError } from './errors.js';

/**
 * Verificación criptográfica + de claims del token SSO que WordPress firma.
 *
 * Diseño (ver README): WordPress, con el usuario YA autenticado, firma un JWT
 * HS256 con un secreto compartido sólo conocido por WP y Didacta. El token es
 * CORTO (≤ maxTtl, default 5 min) y de UN SOLO USO (claim `jti`, el anti-replay
 * lo aplica el host con un store). Esta función es PURA (sin estado): valida
 * firma, audiencia, issuer (si se configura), expiración, TTL máximo y la forma
 * de los claims. El single-use (`jti`) y la resolución/creación del usuario +
 * emisión de sesión viven en el host (necesitan Redis/DB + TokenService).
 *
 * Claims esperados en el token de WP:
 *   - `aud`   audiencia fija — default 'didacta-wp-sso'.
 *   - `iss`   URL del WordPress origen (opcional, se valida si se configura).
 *   - `email` email del usuario logueado en WP (obligatorio).
 *   - `name`  nombre para mostrar (opcional).
 *   - `iat`/`exp` emisión + expiración corta.
 *   - `jti`   nonce único para anti-replay (obligatorio).
 */

export interface WpSsoClaims {
  /** Email normalizado (trim + lowercase). */
  email: string;
  /** Nombre para mostrar, si vino. */
  name?: string;
  /** Nonce único — el host lo marca usado (single-use). */
  jti: string;
  /** Issuer (WordPress origen), si vino. */
  iss?: string;
  /** Expiración (epoch s) — el host usa esto como TTL del marcado anti-replay. */
  exp: number;
}

export interface VerifyWpSsoOptions {
  /** Secreto compartido HMAC (mismo en WP y Didacta). */
  sharedSecret: string;
  /** Audiencia esperada. Default 'didacta-wp-sso'. */
  expectedAudience?: string;
  /** Si se define, el `iss` del token debe coincidir exactamente. */
  expectedIssuer?: string;
  /** TTL máximo permitido (exp - iat). Rechaza tokens longevos. Default 300s. */
  maxTtlSeconds?: number;
  /** Tolerancia de reloj para exp/iat. Default 30s. */
  clockToleranceSeconds?: number;
}

export const WP_SSO_DEFAULT_AUDIENCE = 'didacta-wp-sso';
export const WP_SSO_DEFAULT_MAX_TTL_SECONDS = 300;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function verifyWpSsoToken(
  token: string,
  opts: VerifyWpSsoOptions,
): Promise<WpSsoClaims> {
  if (!token || typeof token !== 'string') {
    throw new WpSsoTokenError('missing_token', 'Falta el token SSO.');
  }
  if (!opts.sharedSecret) {
    throw new WpSsoTokenError(
      'not_configured',
      'WP-SSO no está configurado en Didacta: falta el secreto compartido.',
    );
  }

  const secret = new TextEncoder().encode(opts.sharedSecret);
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      audience: opts.expectedAudience ?? WP_SSO_DEFAULT_AUDIENCE,
      ...(opts.expectedIssuer ? { issuer: opts.expectedIssuer } : {}),
      clockTolerance: opts.clockToleranceSeconds ?? 30,
    });
    payload = result.payload as Record<string, unknown>;
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) {
      throw new WpSsoTokenError(
        'expired',
        'El enlace SSO expiró. Vuelve a entrar desde WordPress.',
      );
    }
    if (e instanceof joseErrors.JWTClaimValidationFailed) {
      const claim = (e as { claim?: string }).claim;
      if (claim === 'aud')
        throw new WpSsoTokenError('audience_invalid', 'Audiencia del token incorrecta.');
      if (claim === 'iss')
        throw new WpSsoTokenError(
          'issuer_invalid',
          'El token no proviene del WordPress configurado.',
        );
      throw new WpSsoTokenError(
        'claim_invalid',
        `Claim inválido en el token: ${claim ?? 'desconocido'}.`,
      );
    }
    if (e instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new WpSsoTokenError(
        'bad_signature',
        'La firma del token SSO no es válida (secreto compartido distinto).',
      );
    }
    throw new WpSsoTokenError('invalid', 'Token SSO inválido o malformado.');
  }

  const iat = typeof payload.iat === 'number' ? payload.iat : undefined;
  const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
  if (iat === undefined || exp === undefined) {
    throw new WpSsoTokenError('claim_invalid', 'El token no trae iat/exp.');
  }
  const maxTtl = opts.maxTtlSeconds ?? WP_SSO_DEFAULT_MAX_TTL_SECONDS;
  if (exp - iat > maxTtl) {
    throw new WpSsoTokenError(
      'ttl_too_long',
      `El token SSO vive más de ${maxTtl}s (exp-iat=${exp - iat}); rechazado por seguridad. Acorta el TTL en el plugin de WordPress.`,
    );
  }

  const jti = typeof payload.jti === 'string' ? payload.jti.trim() : '';
  if (!jti) {
    throw new WpSsoTokenError(
      'claim_invalid',
      'El token no trae `jti` (necesario para anti-replay).',
    );
  }

  const rawEmail = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!rawEmail || !EMAIL_RE.test(rawEmail)) {
    throw new WpSsoTokenError(
      'email_invalid',
      'El token no trae un email válido del usuario de WordPress.',
    );
  }

  const name =
    typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : undefined;
  const iss = typeof payload.iss === 'string' ? payload.iss : undefined;

  return { email: rawEmail, name, jti, iss, exp };
}
