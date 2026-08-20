/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSiteContextCache, getSiteContext } from './site-context';

const contexto = (hostname: string, tenantName: string) => ({
  tenantId: `id-${tenantName}`,
  tenantSlug: tenantName,
  tenantName,
  hostname,
  origin: `https://${hostname}`,
  activeModules: ['mod.hello-world'],
});

describe('getSiteContext', () => {
  beforeEach(() => {
    clearSiteContextCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (host: string) => { status: number; body?: unknown }) {
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      const host = (init?.headers as Record<string, string>)['x-forwarded-host'] as string;
      const { status, body } = handler(host);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('devuelve el contexto del dominio que sirve el sitio', async () => {
    stubFetch((host) => ({ status: 200, body: contexto(host, 'va360') }));
    const site = await getSiteContext('web.va360.academy');
    expect(site?.hostname).toBe('web.va360.academy');
    expect(site?.origin).toBe('https://web.va360.academy');
  });

  it('null cuando el dominio no sirve el sitio (404)', async () => {
    stubFetch(() => ({ status: 404 }));
    expect(await getSiteContext('aula.va360.academy')).toBeNull();
  });

  it('null cuando no hay host', async () => {
    const spy = stubFetch(() => ({ status: 200 }));
    expect(await getSiteContext(null)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('reenvía el host del visitante a la API en vez de dejarla resolver por el interno', async () => {
    const spy = stubFetch((host) => ({ status: 200, body: contexto(host, 'va360') }));
    await getSiteContext('web.va360.academy');
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-forwarded-host']).toBe('web.va360.academy');
  });

  /// El fallo que este test impide: con una caché sin el host en la clave, la
  /// PRIMERA respuesta que entre se sirve a todos los dominios de la instancia
  /// — el sitio de un tenant servido bajo el dominio de otro.
  it('no sirve el contexto de un dominio bajo otro: la clave lleva el host', async () => {
    stubFetch((host) => ({
      status: 200,
      body: contexto(host, host === 'web.va360.academy' ? 'va360' : 'otra-academia'),
    }));

    const primero = await getSiteContext('web.va360.academy');
    const segundo = await getSiteContext('otra.example');

    expect(primero?.tenantName).toBe('va360');
    expect(segundo?.tenantName).toBe('otra-academia');
  });

  it('cachea: dos peticiones seguidas del mismo host llaman una sola vez a la API', async () => {
    const spy = stubFetch((host) => ({ status: 200, body: contexto(host, 'va360') }));
    await getSiteContext('web.va360.academy');
    await getSiteContext('web.va360.academy');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('cachea también el negativo, para que un host desconocido no golpee la API en cada petición', async () => {
    const spy = stubFetch(() => ({ status: 404 }));
    await getSiteContext('desconocido.example');
    await getSiteContext('desconocido.example');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('la caché caduca, así que mover un dominio no exige reiniciar', async () => {
    const spy = stubFetch((host) => ({ status: 200, body: contexto(host, 'va360') }));
    await getSiteContext('web.va360.academy');
    vi.advanceTimersByTime(31_000);
    await getSiteContext('web.va360.academy');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  /// Si la API no contesta no se puede AFIRMAR que un dominio sirva el sitio.
  /// Devolver null deja la petición en el aula, que es lo que ya había: se
  /// falla hacia lo conocido, no hacia lo nuevo.
  it('si la API falla, el dominio no pasa a servir el sitio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('sin red');
      }),
    );
    expect(await getSiteContext('web.va360.academy')).toBeNull();
  });
});
