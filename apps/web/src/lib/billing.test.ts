/**
 * Test del cliente HTTP `billingApi.startCheckout`.
 *
 * Estrategia: mockeamos `fetch` global y verificamos:
 *  - URL correcta del endpoint (codificado),
 *  - método POST sin body (el backend construye los success/cancel URLs
 *    a partir de env, ver `module-registry.service.ts`),
 *  - header Authorization con el bearer pasado,
 *  - retorno del shape `{ orderId, sessionId, url }`,
 *  - propagación de error HTTP (404 → ApiHttpError con código).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from './api-client';
import { billingApi } from './billing';

describe('billingApi.startCheckout', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('llama a POST /api/v1/modules/billing/checkout/:courseId con el bearer y devuelve el shape esperado', async () => {
    const expected = {
      orderId: 'ord_123',
      sessionId: 'cs_test_abc',
      url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
    };

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(expected), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await billingApi.startCheckout('course-uuid-1', 'jwt-token');

    expect(result).toEqual(expected);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    // En entorno test (sin `window`), `apiFetch` antepone `API_INTERNAL_URL`
    // (default http://localhost:4000) — comprobamos el sufijo del path lógico.
    expect(url.endsWith('/api/v1/modules/billing/checkout/course-uuid-1')).toBe(true);
    expect(init.method).toBe('POST');
    // Sin body: el backend construye success/cancel URL a partir de env.
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer jwt-token');
    // Sin Content-Type cuando no hay body (Fastify rechaza CT sin body).
    expect(headers.get('Content-Type')).toBeNull();
  });

  it('codifica el courseId en la URL (caracteres especiales)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ orderId: 'o', sessionId: 's', url: 'https://x' }), {
        status: 200,
      }),
    );
    await billingApi.startCheckout('a/b c', 'jwt');
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url.endsWith('/api/v1/modules/billing/checkout/a%2Fb%20c')).toBe(true);
  });

  it('lanza ApiHttpError preservando el código semántico cuando el backend devuelve 404 BILLING_PRODUCT_NOT_FOUND', async () => {
    // Mockeamos dos veces porque haremos dos `expect().rejects` (cada uno
    // consume su propia llamada a fetch).
    const errorBody = {
      statusCode: 404,
      code: 'BILLING_PRODUCT_NOT_FOUND',
      message: 'No existe producto para courseId=xxx',
    };
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(errorBody), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(errorBody), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    await expect(billingApi.startCheckout('xxx', 'jwt')).rejects.toMatchObject({
      status: 404,
      code: 'BILLING_PRODUCT_NOT_FOUND',
    });
    await expect(billingApi.startCheckout('xxx', 'jwt')).rejects.toBeInstanceOf(ApiHttpError);
  });
});
