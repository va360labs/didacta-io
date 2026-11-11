/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * El idioma SE ACTIVA de verdad: cookie → locale → catálogo servido.
 *
 * `config.test.ts` prueba las piezas (`toSupportedLocale`, `catalogOf`); este
 * prueba el ensamblaje que usa next-intl en cada request. Es el test que le
 * faltaba al bug histórico de `pt-BR`: entonces las piezas decían «portugués»
 * y el request seguía sirviendo el catálogo español, y nada lo comprobaba.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from './messages/en';
import es from './messages/es';
import pt from './messages/pt';

const cookie: { value: string | undefined } = { value: undefined };

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'didacta_locale' && cookie.value !== undefined
        ? { name, value: cookie.value }
        : undefined,
  }),
}));

// `getRequestConfig` solo envuelve la función para que el plugin la descubra.
vi.mock('next-intl/server', () => ({
  getRequestConfig: (factory: unknown) => factory,
}));

type RequestConfig = { locale: string; messages: unknown; timeZone: string };

async function resolveWithCookie(value: string | undefined): Promise<RequestConfig> {
  cookie.value = value;
  const mod = await import('./request');
  const factory = mod.default as unknown as () => Promise<RequestConfig>;
  return factory();
}

describe('i18n/request · cookie → catálogo servido', () => {
  beforeEach(() => {
    cookie.value = undefined;
  });

  it('cookie pt-BR → locale pt-BR y el catálogo PORTUGUÉS', async () => {
    const cfg = await resolveWithCookie('pt-BR');
    expect(cfg.locale).toBe('pt-BR');
    expect(cfg.messages).toBe(pt);
  });

  it('el catálogo servido a pt-BR dice lo suyo en portugués, no en español', async () => {
    // Comprobación de CONTENIDO, no solo de identidad de objeto: si alguien
    // volviera a apuntar `pt` al catálogo español, la aserción de arriba
    // seguiría en verde y esta no.
    const cfg = await resolveWithCookie('pt-BR');
    const messages = cfg.messages as typeof es;
    expect(messages.shell.sidebar.logout).toBe('Sair');
    expect(messages.shell.sidebar.logout).not.toBe(es.shell.sidebar.logout);
    expect(messages.errors.unknown).not.toBe(es.errors.unknown);
    expect(messages.errors.unknown).not.toBe(en.errors.unknown);
  });

  it('control: es-ES y en-US siguen recibiendo cada uno el suyo', async () => {
    expect((await resolveWithCookie('es-ES')).messages).toBe(es);
    expect((await resolveWithCookie('es-AR')).messages).toBe(es);
    expect((await resolveWithCookie('en-US')).messages).toBe(en);
  });

  it('cookie `pt` o `pt-PT` → pt-BR (variante canónica del portugués)', async () => {
    for (const value of ['pt', 'pt-PT']) {
      const cfg = await resolveWithCookie(value);
      expect(cfg.locale, value).toBe('pt-BR');
      expect(cfg.messages, value).toBe(pt);
    }
  });

  it('CAMINO DEGRADADO: sin cookie, o con un idioma sin catálogo → es-ES', async () => {
    for (const value of [undefined, '', 'fr-FR', 'zz', '; DROP TABLE']) {
      const cfg = await resolveWithCookie(value);
      expect(cfg.locale, String(value)).toBe('es-ES');
      expect(cfg.messages, String(value)).toBe(es);
    }
  });
});
