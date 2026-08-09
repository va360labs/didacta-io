import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZoomApiError, ZoomHostNotFoundError } from '../src/errors.js';
import { RealZoomApiClient } from '../src/zoom-api-client.js';

/**
 * Traducción del 404 de Zoom al crear una reunión.
 *
 * Zoom crea las reuniones con `POST /users/{hostEmail}/meetings`: si ese email
 * no es usuario de la cuenta responde 404 con `code: 1001`. Sin traducir, el
 * formador solo veía el volcado crudo de la API.
 */

const CREDS = { accountId: 'acc', clientId: 'cid', clientSecret: 'secret' };

const INPUT = {
  topic: 'Masterclass',
  startTime: new Date('2026-08-03T14:00:00.000Z').toISOString(),
  durationMinutes: 90,
  timezone: 'Europe/Madrid',
  hostEmail: 'anfitrion@example.com',
};

/** Devuelve el token OAuth y luego la respuesta indicada para la llamada API. */
function stubFetch(apiResponse: Response) {
  return vi.fn(async (url: string | URL) => {
    if (String(url).includes('zoom.us/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    return apiResponse;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMeeting — host inexistente en Zoom', () => {
  it('traduce el 404 code 1001 a un error accionable con el email', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(
        new Response(JSON.stringify({ code: 1001, message: 'User does not exist: x.' }), {
          status: 404,
        }),
      ),
    );

    const client = new RealZoomApiClient(CREDS);
    const err = await client.createMeeting(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ZoomHostNotFoundError);
    expect((err as ZoomHostNotFoundError).code).toBe('ZOOM_HOST_NOT_FOUND');
    expect((err as Error).message).toContain('anfitrion@example.com');
    expect((err as Error).message).toContain('cuenta de Zoom');
  });

  it('un 404 con otro código de Zoom sigue siendo un error de API genérico', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(
        new Response(JSON.stringify({ code: 3001, message: 'Meeting does not exist.' }), {
          status: 404,
        }),
      ),
    );

    const err = await new RealZoomApiClient(CREDS).createMeeting(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ZoomApiError);
    expect(err).not.toBeInstanceOf(ZoomHostNotFoundError);
    expect((err as ZoomApiError).zoomCode).toBe(3001);
  });

  it('un 5xx de Zoom no se confunde con un host mal puesto', async () => {
    vi.stubGlobal('fetch', stubFetch(new Response('bad gateway', { status: 502 })));

    const err = await new RealZoomApiClient(CREDS).createMeeting(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ZoomApiError);
    expect((err as ZoomApiError).status).toBe(502);
    // Body no-JSON: sin código de Zoom, pero sin romper el parseo.
    expect((err as ZoomApiError).zoomCode).toBeUndefined();
  });
});
