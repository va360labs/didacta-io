import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifica la firma HMAC-SHA256 de un webhook de Zoom.
 *
 * Zoom envía dos headers en cada webhook:
 *  - `x-zm-request-timestamp`: epoch en SEGUNDOS (valores de 10 dígitos, ej.
 *    `1739923528`; ver docs de Zoom "Using webhooks"). Ojo: el `event_ts` del
 *    body sí va en milisegundos — son formatos distintos.
 *  - `x-zm-signature`: `v0={hmac-sha256-hex}` del string
 *    `v0:{timestamp}:{rawBody}` con el Secret Token de la app.
 *
 * La verificación rechaza:
 *  - timestamps con drift > 5 minutos (mitigación replay).
 *  - firmas con prefijo distinto a `v0=`.
 *  - HMACs que no matcheen en comparación timing-safe.
 *
 * El HMAC se calcula SIEMPRE sobre el header tal cual llegó (normalizar solo
 * afecta al cálculo del drift, nunca al mensaje firmado).
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
  if (!Number.isFinite(ts) || ts <= 0) return false;

  const now = opts.now ? opts.now() : Date.now();
  const drift = Math.abs(now - toEpochMs(ts));
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

/**
 * Normaliza el timestamp del header a epoch ms. Zoom lo manda en segundos,
 * pero aceptamos ambas unidades para no depender de un detalle que Zoom
 * podría cambiar (y porque los fixtures históricos usan ms).
 *
 * Umbral 1e12 ms = septiembre de 2001: cualquier valor por debajo no puede
 * ser una fecha actual en milisegundos, así que son segundos.
 */
const MS_THRESHOLD = 1e12;

function toEpochMs(ts: number): number {
  return ts < MS_THRESHOLD ? ts * 1000 : ts;
}
