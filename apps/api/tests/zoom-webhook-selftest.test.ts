import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyZoomSignature } from '@didacta/mod-zoom-live';
import { runZoomWebhookSelftest } from '../src/modules/zoom-live/zoom-webhook-selftest';

/**
 * La autocomprobación del webhook debe recorrer EXACTAMENTE el camino que
 * recorre Zoom: mismo handshake, misma firma. Aquí el "servidor" es un fetch
 * falso que se comporta como el controlador público en cada situación que
 * hemos visto en instalaciones reales.
 */

const SECRET = 'sekret';
const BASE = 'https://aula.example.com';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const fakeFetch = (h: Handler) => vi.fn((url: string, init: RequestInit) => h(url, init)) as never;

/** Réplica mínima del controlador público: verifica firma y contesta el handshake. */
function likeTheRealController(secret: string | null): Handler {
  return (_url, init) => {
    if (!secret) {
      return new Response(
        JSON.stringify({ message: 'Webhook de Zoom no configurado para este tenant.' }),
        { status: 401 },
      );
    }
    const headers = init.headers as Record<string, string>;
    const rawBody = String(init.body);
    const ok = verifyZoomSignature({
      signatureHeader: headers['x-zm-signature'],
      timestampHeader: headers['x-zm-request-timestamp'],
      rawBody,
      secret,
    });
    if (!ok) return new Response(JSON.stringify({ message: 'Firma inválida.' }), { status: 401 });
    const { plainToken } = (JSON.parse(rawBody) as { payload: { plainToken: string } }).payload;
    return new Response(
      JSON.stringify({
        plainToken,
        encryptedToken: createHmac('sha256', secret).update(plainToken).digest('hex'),
      }),
      { status: 200 },
    );
  };
}

describe('runZoomWebhookSelftest', () => {
  it('sin secret guardado → no_secret, y NO llama a la red', async () => {
    const fetchImpl = fakeFetch(likeTheRealController(SECRET));
    const r = await runZoomWebhookSelftest({ webBaseUrl: BASE, secret: null, fetchImpl });
    expect(r).toEqual({ ok: false, url: `${BASE}/api/v1/webhooks/zoom`, reason: 'no_secret' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('secret correcto y endpoint sano → ok, con la URL pública construida', async () => {
    const fetchImpl = fakeFetch(likeTheRealController(SECRET));
    const r = await runZoomWebhookSelftest({ webBaseUrl: `${BASE}/`, secret: SECRET, fetchImpl });
    expect(r).toEqual({ ok: true, url: `${BASE}/api/v1/webhooks/zoom` });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE}/api/v1/webhooks/zoom`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ event: 'endpoint.url_validation' });
  });

  it('el secret guardado no es el de la app de Zoom → rejected 401 con el mensaje del servidor', async () => {
    const fetchImpl = fakeFetch(likeTheRealController('el-de-verdad'));
    const r = await runZoomWebhookSelftest({ webBaseUrl: BASE, secret: SECRET, fetchImpl });
    expect(r).toEqual({
      ok: false,
      url: `${BASE}/api/v1/webhooks/zoom`,
      reason: 'rejected',
      status: 401,
      detail: 'Firma inválida.',
    });
  });

  it('el dominio no resuelve a ningún tenant → rejected 404', async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(JSON.stringify({ message: 'No se reconoce el dominio de este webhook.' }), {
          status: 404,
        }),
    );
    const r = await runZoomWebhookSelftest({ webBaseUrl: BASE, secret: SECRET, fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: 'rejected', status: 404 });
  });

  it('algo delante contesta 200 con HTML → bad_response', async () => {
    const fetchImpl = fakeFetch(() => new Response('<html>maintenance</html>', { status: 200 }));
    const r = await runZoomWebhookSelftest({ webBaseUrl: BASE, secret: SECRET, fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: 'bad_response', status: 200 });
  });

  it('2xx con JSON pero encryptedToken de otro secret → bad_response', async () => {
    const fetchImpl = fakeFetch((_u, init) => {
      const { plainToken } = (JSON.parse(String(init.body)) as { payload: { plainToken: string } })
        .payload;
      return new Response(
        JSON.stringify({
          plainToken,
          encryptedToken: createHmac('sha256', 'otro').update(plainToken).digest('hex'),
        }),
        { status: 200 },
      );
    });
    const r = await runZoomWebhookSelftest({ webBaseUrl: BASE, secret: SECRET, fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: 'bad_response' });
  });

  it('no hay quien conteste (DNS/TLS/conexión) → unreachable con el código de la causa', async () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = { code: 'ENOTFOUND' };
    const fetchImpl = fakeFetch(() => {
      throw err;
    });
    const r = await runZoomWebhookSelftest({ webBaseUrl: BASE, secret: SECRET, fetchImpl });
    expect(r).toEqual({
      ok: false,
      url: `${BASE}/api/v1/webhooks/zoom`,
      reason: 'unreachable',
      detail: 'ENOTFOUND',
    });
  });
});
