// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * La marca del aula en las pantallas sin sesión (acceso, 404, venta) frente a
 * un fallo de `GET /auth/tenant-context`, sobre todo el 429 del rate limit.
 *
 * Antes, un solo fallo se guardaba como «sin aula» en la caché del módulo para
 * el resto de la pestaña: el panel del acceso salía con «Tu academia» y las
 * iniciales neutras, y el formulario pedía la «Organización», hasta recargar.
 * Ahora: lo último bueno de la pestaña (sobrevive a la recarga) y un único
 * reintento cuando la API dice (`Retry-After`).
 *
 * La API se dobla por `fetch`, la frontera real del cliente.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTenantContext,
  isStaleTenantContext,
  resetTenantContextForTests,
  tenantContextRetryDelayMs,
  useTenantContext,
  type TenantContextResponse,
} from './tenant-context';
import { ApiHttpError } from './api-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AULA: TenantContextResponse = {
  tenant: {
    id: 'tenant-cafe',
    slug: 'cafe',
    name: 'Café Primeiro Gole',
    logoUrl: null,
    brandHue: 24,
    brandSaturation: 90,
  },
  host: 'cafe.didacta.io',
};

const ok = () => new Response(JSON.stringify(AULA), { status: 200 });
const limitado = (retryAfter = '2') =>
  new Response(JSON.stringify({ statusCode: 429, code: 'rate_limit_exceeded' }), {
    status: 429,
    headers: { 'Retry-After': retryAfter },
  });

let fetchMock: ReturnType<typeof vi.fn>;

/** Deja correr las promesas pendientes (fetch → text → then). */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  resetTenantContextForTests();
  window.sessionStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  resetTenantContextForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchTenantContext ante un 429', () => {
  it('control: una respuesta buena se cachea y no se vuelve a pedir', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    const res = await fetchTenantContext();
    expect(res.tenant?.name).toBe('Café Primeiro Gole');
    expect(isStaleTenantContext(res)).toBe(false);
    await fetchTenantContext();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('el fallo NO se queda para toda la pestaña: se vuelve a preguntar cuando dice Retry-After', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(limitado('2')).mockResolvedValueOnce(ok());

    const primera = await fetchTenantContext();
    expect(primera.tenant).toBeNull();
    expect(isStaleTenantContext(primera)).toBe(true);

    // Mientras espera, nadie más gasta el cupo que se acaba de agotar.
    await fetchTenantContext();
    await fetchTenantContext();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const despues = await fetchTenantContext();
    expect(despues.tenant?.name).toBe('Café Primeiro Gole');
    expect(isStaleTenantContext(despues)).toBe(false);
  });

  it('con una marca buena de antes (la pestaña se recargó), el 429 devuelve esa marca', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await fetchTenantContext();

    // Recarga: el módulo vuelve a cargarse, el sessionStorage de la pestaña sigue.
    resetTenantContextForTests();
    fetchMock.mockResolvedValueOnce(limitado('30'));

    const res = await fetchTenantContext();
    expect(res.tenant?.name).toBe('Café Primeiro Gole');
    expect(res.tenant?.brandHue).toBe(24);
    // Sirve para pintar, no para decidir (la pantalla de pausa lo ignora).
    expect(isStaleTenantContext(res)).toBe(true);
  });

  it('una API caída deja de reintentarse sola tras unos intentos', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await fetchTenantContext();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    // La llamada inicial y 3 reintentos, ni uno más.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('la espera es la del Retry-After, con tope de un minuto', () => {
    const conRetry = (s: number | undefined) =>
      new ApiHttpError({ message: 'x', status: 429, retryAfterSeconds: s });
    expect(tenantContextRetryDelayMs(conRetry(7))).toBe(7_000);
    expect(tenantContextRetryDelayMs(conRetry(600))).toBe(60_000);
    expect(tenantContextRetryDelayMs(conRetry(undefined))).toBe(5_000);
    expect(tenantContextRetryDelayMs(new TypeError('red'))).toBe(5_000);
  });
});

describe('useTenantContext (el panel de marca del acceso)', () => {
  let container: HTMLDivElement;
  let root: Root;

  function Panel() {
    const { loading, tenant } = useTenantContext();
    if (loading) return <span>cargando</span>;
    return <span>{tenant?.name ?? 'Tu academia'}</span>;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('tras un 429 sin nada guardado, la marca del aula llega con el reintento', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(limitado('2')).mockResolvedValueOnce(ok());

    await act(async () => {
      root.render(<Panel />);
      await flush();
    });
    expect(container.textContent).toBe('Tu academia');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await flush();
    });
    expect(container.textContent).toBe('Café Primeiro Gole');
  });

  it('tras un 429 con la marca de antes, nunca sale «Tu academia»', async () => {
    window.sessionStorage.setItem('didacta.tenant-context', JSON.stringify(AULA));
    fetchMock.mockResolvedValueOnce(limitado('30'));

    await act(async () => {
      root.render(<Panel />);
      await flush();
    });
    expect(container.textContent).toBe('Café Primeiro Gole');
  });
});
