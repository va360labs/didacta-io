import { createHmac, timingSafeEqual } from 'node:crypto';

// ============================================================================
// Tickets firmados de corta vida (HMAC-SHA256 con AUTH_SECRET) para encadenar
// los pasos del flujo de inscripción sin estado en BD: el ticket de Telegram
// (paso 1) y el verificationToken (tras el OTP). Son stateless, autoexpiran y
// no se pueden falsificar sin el secreto. Formato: <b64url(payload)>.<b64url(sig)>.
// Patrón timing-safe (clon de webhook-signature.ts). Cero deps nuevas.
// ============================================================================

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Firma un payload con un TTL. El payload se serializa con un campo `exp`
 * absoluto (epoch segundos). Devuelve el ticket compacto.
 */
export function signTicket(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
): string {
  const body = { ...payload, exp: nowSeconds() + ttlSeconds };
  const data = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verifica firma + expiración. Devuelve los claims o `null` si el ticket es
 * inválido, está manipulado o ha expirado. Nunca lanza.
 */
export function verifyTicket<T = Record<string, unknown>>(token: string, secret: string): T | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!data || !sig) return null;

  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  try {
    if (sig.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { exp?: unknown }).exp !== 'number' ||
    (body as { exp: number }).exp < nowSeconds()
  ) {
    return null;
  }
  return body as T;
}
