/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAcademyLocaleCache, getAcademyLocale, publicHost } from './academy-locale';

function headersOf(map: Record<string, string>) {
  return { get: (k: string) => map[k] ?? null };
}

describe('idioma del aula desde el servidor del web', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearAcademyLocaleCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('pregunta por el host del VISITANTE, no por el del salto interno', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ locale: 'en' })));
    expect(await getAcademyLocale('cafe.didacta.io')).toBe('en');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/tenancy\/locale$/);
    expect((init as RequestInit).headers).toEqual({ 'x-forwarded-host': 'cafe.didacta.io' });
  });

  it('caché por host: una sola llamada por aula, y cada aula con su idioma', async () => {
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) => {
      const host = (init.headers as Record<string, string>)['x-forwarded-host'];
      return new Response(JSON.stringify({ locale: host === 'en.test' ? 'en' : 'es' }));
    });
    expect(await getAcademyLocale('en.test')).toBe('en');
    expect(await getAcademyLocale('en.test')).toBe('en');
    expect(await getAcademyLocale('es.test')).toBe('es');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caduca: un cambio en Ajustes se nota sin reiniciar', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ locale: 'es' })));
    expect(await getAcademyLocale('aula.test')).toBe('es');
    vi.advanceTimersByTime(31_000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ locale: 'en' })));
    expect(await getAcademyLocale('aula.test')).toBe('en');
  });

  it('API caída, respuesta rara o host ajeno: null (la web se queda en su idioma por defecto)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await getAcademyLocale('a.test')).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 500 }));
    expect(await getAcademyLocale('b.test')).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ locale: 'pt-BR' })));
    expect(await getAcademyLocale('c.test')).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ locale: null })));
    expect(await getAcademyLocale('d.test')).toBeNull();
    expect(await getAcademyLocale(null)).toBeNull();
  });

  it('un fallo se reintenta pronto (no deja el aula en español 30 s)', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new Error('arrancando'));
    expect(await getAcademyLocale('aula.test')).toBeNull();
    vi.advanceTimersByTime(6_000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ locale: 'en' })));
    expect(await getAcademyLocale('aula.test')).toBe('en');
  });

  it('host público: el reenviado por el proxy y, si no, el de la petición', () => {
    expect(publicHost(headersOf({ host: 'localhost:3000', 'x-forwarded-host': 'Cafe.Test' }))).toBe(
      'cafe.test',
    );
    expect(publicHost(headersOf({ 'x-forwarded-host': 'a.test, proxy.internal' }))).toBe('a.test');
    expect(publicHost(headersOf({ host: 'b.test:3209' }))).toBe('b.test:3209');
    expect(publicHost(headersOf({}))).toBeNull();
  });
});
