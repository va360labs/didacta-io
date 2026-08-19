/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * `apiFetch` frente a respuestas que NO son JSON.
 *
 * Un 502/504 del proxy llega con una página HTML. El parseo era un
 * `JSON.parse` pelado sobre el body de cualquier respuesta, así que lanzaba
 * SyntaxError antes de llegar al manejo del 401: el refresh-and-retry no
 * corría y los callers recibían un error sin `status` con el que no podían
 * decidir nada (ni reintentar, ni distinguir "caída" de "sesión expirada").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiHttpError } from './api-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: string, contentType = 'text/html') {
  const fetchMock = vi.fn(
    async () => new Response(body, { status, headers: { 'Content-Type': contentType } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('apiFetch · respuestas que no son JSON', () => {
  it('un 502 con HTML del proxy da un ApiHttpError con su status, no un SyntaxError', async () => {
    stubFetch(502, '<html><body><h1>502 Bad Gateway</h1></body></html>');

    const error = await apiFetch('/api/v1/lo-que-sea').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiHttpError);
    expect((error as ApiHttpError).status).toBe(502);
  });

  it('un 504 con texto plano tampoco revienta el parseo', async () => {
    stubFetch(504, 'upstream timed out', 'text/plain');

    const error = await apiFetch('/api/v1/lo-que-sea').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiHttpError);
    expect((error as ApiHttpError).status).toBe(504);
  });

  it('un 200 con body vacío sigue resolviendo a null', async () => {
    stubFetch(200, '', 'application/json');

    await expect(apiFetch('/api/v1/lo-que-sea')).resolves.toBeNull();
  });

  it('un JSON de error normal conserva su message y su code', async () => {
    stubFetch(
      422,
      JSON.stringify({ message: 'no cuadra', code: 'X_NO_CUADRA' }),
      'application/json',
    );

    const error = (await apiFetch('/api/v1/lo-que-sea').catch((e: unknown) => e)) as ApiHttpError;

    expect(error.status).toBe(422);
    expect(error.message).toBe('no cuadra');
    expect(error.code).toBe('X_NO_CUADRA');
  });
});
