/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firmas de Bunny que se calculan en el SERVIDOR (la clave nunca sale de aquí).
 * Cálculo local, sin red ni estado.
 */

/**
 * Firma de una subida TUS directa del navegador a Bunny Stream:
 * `SHA256_HEX(library_id + api_key + expiration_time + video_id)`.
 *
 * https://bunny.net/docs/stream/tus-resumable-uploads — «The signature must be
 * generated on your server to keep your API key secure». Con ella el navegador
 * solo puede subir bytes a ESE vídeo hasta `expiresUnix`; no puede crear,
 * listar ni borrar nada.
 */
export function bunnyTusSignature(input: {
  libraryId: string;
  apiKey: string;
  expiresUnix: number;
  videoId: string;
}): string {
  return createHash('sha256')
    .update(`${input.libraryId}${input.apiKey}${input.expiresUnix}${input.videoId}`)
    .digest('hex');
}

/**
 * URL de la CDN firmada con «token authentication» avanzada (HMAC-SHA256),
 * en formato de query string. Porte de `signUrl` de
 * https://github.com/BunnyWay/BunnyCDN.TokenAuthentication (nodejs/token.js),
 * sin IP, países ni límite de velocidad, que aquí no se usan:
 *
 *   token = "HS256-" + Base64URL(HMAC-SHA256(key, path + expires + signingData))
 *
 * `signingData` son los parámetros (aquí, como mucho, `token_path`) ordenados y
 * unidos como `k=v&…`. Con `tokenPath` el token vale para todo lo que cuelga
 * de ese directorio (lo que hace falta para un HLS: playlist + segmentos).
 *
 * Los tests fijan los vectores del propio repositorio de Bunny.
 */
export function signBunnyCdnUrl(input: {
  url: string;
  securityKey: string;
  expiresUnix: number;
  tokenPath?: string;
}): string {
  if (!input.securityKey) throw new Error('securityKey vacía');
  const parsed = new URL(input.url);
  const params: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams) params[k] = v;
  if (input.tokenPath) params['token_path'] = input.tokenPath;
  const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const signingData = sorted.map(([k, v]) => `${k}=${v}`).join('&');
  const urlData = sorted.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const signaturePath = input.tokenPath || parsed.pathname;
  const expires = String(input.expiresUnix);

  const hmac = createHmac('sha256', input.securityKey);
  hmac.update(signaturePath);
  hmac.update(expires);
  hmac.update(signingData);
  const token =
    'HS256-' + hmac.digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tail = urlData ? `&${urlData}` : '';
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}?token=${token}${tail}&expires=${expires}`;
}

/**
 * ¿El webhook lo firmó Bunny? HMAC-SHA256 del cuerpo CRUDO con la clave de
 * solo lectura de la biblioteca, en hex minúsculas (versión `v1`).
 * https://bunny.net/docs/stream/webhooks#signature-validation
 */
export function verifyBunnyWebhookSignature(input: {
  rawBody: Buffer;
  signature: string | undefined;
  version: string | undefined;
  algorithm: string | undefined;
  secret: string;
}): boolean {
  if (input.version !== 'v1' || input.algorithm !== 'hmac-sha256') return false;
  const given = (input.signature ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest();
  const givenBytes = Buffer.from(given, 'hex');
  return givenBytes.length === expected.length && timingSafeEqual(givenBytes, expected);
}
