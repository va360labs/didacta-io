/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomBytes } from 'node:crypto';
import { buildUrlValidationResponse, signZoomWebhook } from '@didacta/mod-zoom-live';

/**
 * Autocomprobación del webhook de Zoom: Didacta se llama a sí misma por su
 * URL PÚBLICA con el mismo handshake `endpoint.url_validation` que manda Zoom
 * (mismo body, misma firma HMAC con el Secret Token del tenant) y comprueba
 * que la respuesta es la que Zoom aceptaría.
 *
 * Nació de un usuario de la versión community (EasyPanel + Traefik) al que
 * Zoom rechazaba la URL sin decir por qué: su instancia contestaba 401 porque
 * el Secret Token no estaba guardado aún. Desde Zoom solo se ve «validación
 * fallida»; desde aquí se ve el motivo exacto, y además se recorre el mismo
 * camino que Zoom (proxy → web → API), así que también caza un proxy que no
 * pasa el Host o una URL mal escrita.
 *
 * `reason`:
 *  - `no_secret`: el tenant no tiene Secret Token guardado. Primero se
 *    guarda, después se pulsa «Validate» en Zoom.
 *  - `unreachable`: no se pudo conectar con la URL pública (DNS, TLS, timeout).
 *  - `rejected`: la URL contesta pero no 2xx; `status` y `detail` traen lo que
 *    dijo (401 firma inválida → el secret guardado no es el de la app; 404 →
 *    el dominio no resuelve a este tenant).
 *  - `bad_response`: 2xx pero el cuerpo no es el handshake esperado (algo
 *    delante de Didacta está contestando en su lugar).
 */
export type WebhookSelftestResult =
  | { ok: true; url: string }
  | {
      ok: false;
      url: string;
      reason: 'no_secret' | 'unreachable' | 'rejected' | 'bad_response';
      status?: number;
      detail?: string;
    };

export const ZOOM_WEBHOOK_PATH = '/api/v1/webhooks/zoom';

export async function runZoomWebhookSelftest(opts: {
  webBaseUrl: string;
  secret: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<WebhookSelftestResult> {
  const url = `${opts.webBaseUrl.replace(/\/$/, '')}${ZOOM_WEBHOOK_PATH}`;
  if (!opts.secret) return { ok: false, url, reason: 'no_secret' };

  const plainToken = randomBytes(16).toString('hex');
  const rawBody = JSON.stringify({
    event: 'endpoint.url_validation',
    event_ts: Date.now(),
    payload: { plainToken },
  });
  const expected = buildUrlValidationResponse(plainToken, opts.secret);

  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Didacta-Zoom-Webhook-Selftest',
        ...signZoomWebhook({ rawBody, secret: opts.secret }),
      },
      body: rawBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
  } catch (e) {
    return { ok: false, url, reason: 'unreachable', detail: describeError(e) };
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, url, reason: 'rejected', status: res.status, detail: extractMessage(text) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      url,
      reason: 'bad_response',
      status: res.status,
      detail: text.slice(0, 200),
    };
  }
  const got = parsed as { plainToken?: unknown; encryptedToken?: unknown };
  if (got?.plainToken !== expected.plainToken || got?.encryptedToken !== expected.encryptedToken) {
    return { ok: false, url, reason: 'bad_response', status: res.status };
  }
  return { ok: true, url };
}

/** El `message` del error JSON de Nest si lo hay; si no, el texto recortado. */
function extractMessage(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const j = JSON.parse(text) as { message?: unknown };
    if (typeof j.message === 'string') return j.message;
  } catch {
    // no era JSON
  }
  return text.slice(0, 200);
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    // `fetch` envuelve la causa real (ECONNREFUSED, ENOTFOUND, cert…) en `cause`.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return cause.code;
    if (cause?.message) return cause.message;
    return e.name === 'TimeoutError' ? 'timeout' : e.message;
  }
  return String(e);
}
