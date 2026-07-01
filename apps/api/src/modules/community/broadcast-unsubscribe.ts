import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Token de baja de avisos masivos. Formato `base64url(payload).base64url(hmac)`
 * con payload `{ t: tenantId, u: userId }` firmado HMAC-SHA256. Sin expiración
 * (un enlace de baja no debe caducar). Lo firma el worker de broadcast (al meter
 * el enlace en cada email) y lo verifica el endpoint público de unsubscribe.
 */
function secret(): string {
  return (
    process.env['AUTH_SECRET'] ?? process.env['TENANT_SETTINGS_ENC_KEY'] ?? 'didacta-dev-secret'
  );
}

export function signUnsubscribeToken(tenantId: string, userId: string): string {
  const data = Buffer.from(JSON.stringify({ t: tenantId, u: userId }), 'utf8').toString(
    'base64url',
  );
  const sig = createHmac('sha256', secret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): { tenantId: string; userId: string } | null {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = createHmac('sha256', secret()).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as {
      t?: string;
      u?: string;
    };
    if (!payload.t || !payload.u) return null;
    return { tenantId: payload.t, userId: payload.u };
  } catch {
    return null;
  }
}
