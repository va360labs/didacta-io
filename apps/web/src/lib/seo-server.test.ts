/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * La marca del aula pedida desde el SERVIDOR del web (fichas, catálogo,
 * favicon, imagen para redes) frente a un fallo de la API, sobre todo el 429
 * del rate limit.
 *
 * El cupo es por visitante (su IP viaja en `X-Forwarded-For`), pero la caché
 * del favicon es POR HOST: antes, el 429 de un solo visitante con su cupo
 * agotado se guardaba como «sin marca» y el favicon salía con las iniciales
 * neutras a todos los visitantes de esa aula (con cinco minutos de caché en
 * el navegador). Ahora un fallo deja la última marca buena del aula.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPublicBrandCache, fetchPublicBrand, fetchPublicBrandCached } from './seo-server';

const AULA = {
  tenant: {
    id: 't-cafe',
    slug: 'cafe',
    name: 'Café Primeiro Gole',
    logoUrl: null,
    faviconUrl: null,
    coverUrl: null,
    brandHue: 24,
    brandSaturation: 90,
  },
  host: 'cafe.didacta.io',
};

let fetchMock: ReturnType<typeof vi.fn>;
const ok = () => new Response(JSON.stringify(AULA), { status: 200 });
const limitado = () => new Response('{}', { status: 429, headers: { 'Retry-After': '40' } });

beforeEach(() => {
  clearPublicBrandCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('marca del aula desde el servidor', () => {
  it('lleva el host y la IP del visitante (su cupo, no el del servidor)', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    expect((await fetchPublicBrand('cafe.didacta.io', '203.0.113.7'))?.name).toBe(
      'Café Primeiro Gole',
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/auth\/tenant-context$/);
    expect(init.headers).toEqual({
      'x-forwarded-host': 'cafe.didacta.io',
      'x-forwarded-for': '203.0.113.7',
    });
  });

  it('el 429 de UN visitante no deja el favicon del aula sin marca para todos', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(ok());
    expect((await fetchPublicBrandCached('cafe.didacta.io', '203.0.113.7'))?.name).toBe(
      'Café Primeiro Gole',
    );

    // Caduca la caché y la siguiente petición es de alguien sin cupo.
    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(limitado());
    expect((await fetchPublicBrandCached('cafe.didacta.io', '198.51.100.9'))?.brandHue).toBe(24);

    // El siguiente visitante, dentro de la ventana corta del fallo, también.
    expect((await fetchPublicBrandCached('cafe.didacta.io', '192.0.2.4'))?.name).toBe(
      'Café Primeiro Gole',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Pasada la ventana corta se vuelve a preguntar.
    vi.advanceTimersByTime(6_000);
    fetchMock.mockResolvedValueOnce(ok());
    await fetchPublicBrandCached('cafe.didacta.io', '192.0.2.4');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('la ficha (sin caché) ante un 429 pinta la última marca buena, no la neutra', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await fetchPublicBrand('cafe.didacta.io', '203.0.113.7');
    fetchMock.mockResolvedValueOnce(limitado());
    expect((await fetchPublicBrand('cafe.didacta.io', '198.51.100.9'))?.name).toBe(
      'Café Primeiro Gole',
    );
  });

  it('control: cada aula con su marca, y un fallo sin marca previa sigue siendo null', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await fetchPublicBrand('cafe.didacta.io', null);
    fetchMock.mockResolvedValueOnce(limitado());
    expect(await fetchPublicBrand('otra.didacta.io', null)).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await fetchPublicBrandCached('tercera.didacta.io', null)).toBeNull();
  });

  it('control: un dominio que no es de ningún aula no tiene marca', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ tenant: null, host: 'x' }), { status: 200 }),
    );
    expect(await fetchPublicBrandCached('libre.didacta.io', null)).toBeNull();
    expect(await fetchPublicBrand(null, null)).toBeNull();
  });
});
