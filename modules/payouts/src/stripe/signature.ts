/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { PayoutsWebhookSignatureInvalidError } from '../errors.js';

/**
 * Verificación de la firma de un webhook de Stripe (cabecera
 * `Stripe-Signature`), sin SDK.
 *
 * Formato de la cabecera: `t=<unix>,v1=<hex>[,v1=<hex>…][,v0=…]`. La firma es
 * `HMAC-SHA256(secreto, "<t>.<cuerpo crudo>")` en hexadecimal. Puede venir más
 * de un `v1` (Stripe firma con el secreto nuevo y el viejo mientras se rota).
 *
 * Por qué VARIOS secretos: Stripe da un secreto por endpoint, y los eventos de
 * la cuenta de plataforma, los de las cuentas conectadas y los de la API v2
 * salen por destinos distintos. La URL del webhook de plataforma es una; los
 * secretos, dos o tres, todos del operador.
 *
 * Tiempo constante: se calcula el HMAC con TODOS los secretos y se compara con
 * TODAS las firmas `v1`, sin salir al primer acierto, y cada comparación usa
 * `timingSafeEqual` sobre 32 bytes. El tiempo no dice ni qué secreto casó ni
 * por cuántos caracteres falló una firma.
 *
 * El cuerpo tiene que ser el CRUDO, byte a byte: volver a serializar el JSON
 * cambia la firma.
 */

/** Tolerancia de reloj por defecto: la misma que usa el SDK de Stripe. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

const SIGNATURE_BYTES = 32;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/i;

export type SignatureFailureReason =
  /** No llegó la cabecera `Stripe-Signature`. */
  | 'missing_header'
  /** La cabecera no trae `t=` numérico o ningún `v1=`. */
  | 'malformed_header'
  /** No hay ningún secreto configurado contra el que verificar. */
  | 'no_secrets'
  /** Ninguna firma `v1` casa con ningún secreto. */
  | 'no_match'
  /** La firma es buena pero la marca de tiempo está fuera de tolerancia. */
  | 'timestamp_out_of_tolerance';

export type SignatureVerification =
  | {
      readonly valid: true;
      /** Marca de tiempo firmada (segundos Unix). */
      readonly timestamp: number;
      /** Posición, en la lista recibida, del secreto que casó. */
      readonly secretIndex: number;
    }
  | { readonly valid: false; readonly reason: SignatureFailureReason };

export interface VerifyStripeSignatureParams {
  /** Cuerpo CRUDO de la petición. */
  readonly payload: string | Buffer;
  /** Valor de la cabecera `Stripe-Signature`. */
  readonly header: string | null | undefined;
  /** Secretos `whsec_…` aceptados. */
  readonly secrets: readonly string[];
  /** Segundos de desfase admitidos, hacia atrás y hacia delante. */
  readonly toleranceSeconds?: number;
  /** Reloj inyectable (segundos Unix). Por defecto, el del sistema. */
  readonly nowSeconds?: number;
}

interface ParsedHeader {
  readonly timestamp: number;
  /** El `t=` tal cual llegó: es lo que se firmó, no su valor numérico. */
  readonly rawTimestamp: string;
  readonly signatures: readonly string[];
}

function parseHeader(header: string): ParsedHeader | null {
  let rawTimestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      // Dos `t=` es una cabecera manipulada: no se elige uno, se rechaza.
      if (rawTimestamp !== undefined) return null;
      rawTimestamp = value;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }
  if (rawTimestamp === undefined || !/^\d{1,12}$/.test(rawTimestamp)) return null;
  if (signatures.length === 0) return null;
  return { timestamp: Number(rawTimestamp), rawTimestamp, signatures };
}

function expectedSignature(secret: string, rawTimestamp: string, payload: Buffer): Buffer {
  return createHmac('sha256', secret).update(`${rawTimestamp}.`, 'utf8').update(payload).digest();
}

/**
 * Compara una firma candidata (hex) con la esperada (32 bytes) en tiempo
 * constante. Una candidata que no son 64 dígitos hexadecimales se compara
 * igualmente —contra 32 bytes a cero— para no acortar el camino.
 */
function matches(expected: Buffer, candidateHex: string): boolean {
  const wellFormed = HEX_SIGNATURE.test(candidateHex);
  const candidate = wellFormed ? Buffer.from(candidateHex, 'hex') : Buffer.alloc(SIGNATURE_BYTES);
  const equal = timingSafeEqual(expected, candidate);
  return wellFormed && equal;
}

export function verifyStripeSignature(params: VerifyStripeSignatureParams): SignatureVerification {
  if (!params.header) return { valid: false, reason: 'missing_header' };

  // Un secreto vacío firmaría cualquier cosa que el atacante firme con '': fuera.
  const secrets = params.secrets.filter((secret) => secret.length > 0);
  if (secrets.length === 0) return { valid: false, reason: 'no_secrets' };

  const parsed = parseHeader(params.header);
  if (!parsed) return { valid: false, reason: 'malformed_header' };

  const payload =
    typeof params.payload === 'string' ? Buffer.from(params.payload, 'utf8') : params.payload;

  let secretIndex = -1;
  // Posiciones respecto a la lista ORIGINAL, no a la filtrada.
  for (let i = 0; i < params.secrets.length; i += 1) {
    const secret = params.secrets[i]!;
    if (secret.length === 0) continue;
    const expected = expectedSignature(secret, parsed.rawTimestamp, payload);
    for (const candidate of parsed.signatures) {
      // Sin `break`: se recorren todos aunque ya haya casado uno.
      if (matches(expected, candidate) && secretIndex === -1) secretIndex = i;
    }
  }
  if (secretIndex === -1) return { valid: false, reason: 'no_match' };

  // La tolerancia se mira DESPUÉS de la firma: a quien no sabe firmar no se le
  // cuenta si su reloj iba bien.
  const tolerance = params.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  return { valid: true, timestamp: parsed.timestamp, secretIndex };
}

/**
 * Igual que `verifyStripeSignature`, pero lanza
 * `PayoutsWebhookSignatureInvalidError` si la firma no vale.
 */
export function assertStripeSignature(params: VerifyStripeSignatureParams): {
  timestamp: number;
  secretIndex: number;
} {
  const result = verifyStripeSignature(params);
  if (!result.valid) throw new PayoutsWebhookSignatureInvalidError(result.reason);
  return { timestamp: result.timestamp, secretIndex: result.secretIndex };
}

/**
 * Construye la cabecera `Stripe-Signature` de un cuerpo. Para los tests y para
 * reenviar a una API local un evento real leído de `/v1/events` (patrón de
 * `tools/payments-sandbox`). No se usa en el camino de producción.
 */
export function signStripePayload(
  payload: string | Buffer,
  secret: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const signature = expectedSignature(secret, String(timestampSeconds), body).toString('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}
