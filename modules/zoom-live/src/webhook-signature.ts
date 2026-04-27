import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifica la firma HMAC-SHA256 de un webhook de Zoom.
 *
 * Zoom envía dos headers en cada webhook:
 *  - `x-zm-request-timestamp`: epoch ms del envío.
 *  - `x-zm-signature`: `v0={hmac-sha256-hex}` del string
 *    `v0:{timestamp}:{rawBody}` con secret de validación.
 *
 * La verificación rechaza:
 *  - timestamps con drift > 5 minutos (mitigación replay).
 *  - firmas con prefijo distinto a `v0=`.
 *  - HMACs que no matcheen en comparación timing-safe.
 *
 * Devuelve `true` si la firma es válida; `false` en cualquier otro caso
 * (sin tirar para que el caller decida la respuesta HTTP).
 */
export function verifyZoomSignature(opts: {
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  rawBody: string;
  secret: string;
  /** Drift máximo permitido en ms; default 5 minutos. */
  maxDriftMs?: number;
  /** Override de Date.now() para tests deterministas. */
  now?: () => number;
}): boolean {
  const { signatureHeader, timestampHeader, rawBody, secret } = opts;
  if (!signatureHeader || !timestampHeader || !secret) return false;

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;

  const now = opts.now ? opts.now() : Date.now();
  const drift = Math.abs(now - ts);
  if (drift > (opts.maxDriftMs ?? 5 * 60 * 1000)) return false;

  if (!signatureHeader.startsWith('v0=')) return false;
  const provided = signatureHeader.slice(3);

  const expected = createHmac('sha256', secret)
    .update(`v0:${timestampHeader}:${rawBody}`)
    .digest('hex');

  // Comparación timing-safe requiere mismo length.
  if (provided.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
