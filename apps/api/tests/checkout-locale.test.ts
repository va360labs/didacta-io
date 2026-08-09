/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Captura del idioma en el CHECKOUT.
 *
 * El hueco que cierra: las dos bienvenidas de compra leen el `locale` de la
 * fila de `user` que el webhook acaba de crear, y esa columna tomaba SIEMPRE su
 * default porque nada aguas arriba escribía otro valor. Un comprador anglófono
 * acababa con `es-ES` guardado y recibía el email en español aunque hubiera
 * comprado con la web en inglés.
 *
 * Las dos mitades del transporte se prueban aquí: leer la cookie del request
 * (ida) y validar lo que vuelve en la metadata de Stripe (vuelta).
 */

import { describe, expect, it } from 'vitest';
import {
  LOCALE_COOKIE,
  readRequestLocale,
  sanitizeCheckoutLocale,
} from '../src/common/checkout-locale';
import { ALLOWED_LOCALES } from '../src/auth/me.controller';
import { HUB_DEFAULT_LOCALE } from '../src/modules/notifications/email-template-catalog';

describe('readRequestLocale · el idioma activo de la UI', () => {
  it('lee la cookie que escribe la web', () => {
    expect(readRequestLocale({ cookie: `${LOCALE_COOKIE}=en-US` })).toBe('en-US');
  });

  it('la encuentra entre otras cookies y tolera espacios', () => {
    expect(
      readRequestLocale({ cookie: `foo=1;  ${LOCALE_COOKIE} = es-AR ; didacta.session=xyz` }),
    ).toBe('es-AR');
  });

  it('acepta el valor url-encoded (la web lo escribe con encodeURIComponent)', () => {
    expect(readRequestLocale({ cookie: `${LOCALE_COOKIE}=${encodeURIComponent('en-US')}` })).toBe(
      'en-US',
    );
  });

  it('una cabecera repetida (array) usa la primera', () => {
    expect(
      readRequestLocale({ cookie: [`${LOCALE_COOKIE}=en-US`, `${LOCALE_COOKIE}=es-ES`] }),
    ).toBe('en-US');
  });

  it('CAMINO DEGRADADO: sin cookie devuelve undefined, no un idioma inventado', () => {
    // Es el caso NORMAL: un visitante que nunca tocó el selector. Devolver
    // `undefined` deja que la columna `user.locale` tome su default de BD.
    for (const cookie of [undefined, '', 'otra=1', `${LOCALE_COOKIE}=`, 'didacta_localex=en-US']) {
      expect(readRequestLocale({ cookie }), String(cookie)).toBeUndefined();
    }
  });

  it('CAMINO DEGRADADO: un tag que la API no persiste se descarta ENTERO', () => {
    // `pt-BR` sigue existiendo en perfiles antiguos y `en` es un tag válido de
    // BCP-47 que esta API no guarda. No se normaliza a `en-US`: adivinar la
    // región es inventarse la preferencia de alguien.
    for (const value of ['pt-BR', 'en', 'es', 'EN-US', 'zz-ZZ', '../../etc/passwd', '{}']) {
      expect(readRequestLocale({ cookie: `${LOCALE_COOKIE}=${value}` }), value).toBeUndefined();
    }
  });

  it('una cookie con un % suelto no rompe el checkout', () => {
    expect(readRequestLocale({ cookie: `${LOCALE_COOKIE}=%E0%A4%A` })).toBeUndefined();
  });
});

describe('sanitizeCheckoutLocale · lo que vuelve de Stripe', () => {
  it('deja pasar los locales que la API persiste', () => {
    for (const locale of ALLOWED_LOCALES) {
      expect(sanitizeCheckoutLocale(locale), locale).toBe(locale);
    }
  });

  it('descarta cualquier otra cosa', () => {
    // La metadata de una session la puede reenviar cualquiera con el secreto
    // del webhook, así que el valor se vuelve a validar antes de tocar `user`.
    for (const value of [undefined, null, '', '  ', 42, {}, [], 'pt-BR', 'en', 'DROP TABLE']) {
      expect(sanitizeCheckoutLocale(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('tolera el espaciado de la metadata', () => {
    expect(sanitizeCheckoutLocale(' en-US ')).toBe('en-US');
  });
});

describe('la lista de locales del checkout NO se desincroniza', () => {
  it('acepta exactamente los mismos que `ALLOWED_LOCALES` de /me/profile', () => {
    // Se redeclara en `common/checkout-locale.ts` para no importar un
    // controlador desde `common/`. Si alguien añade un idioma al perfil y no
    // aquí, el comprador podría elegirlo en la web y el checkout lo tiraría.
    for (const locale of ALLOWED_LOCALES) {
      expect(sanitizeCheckoutLocale(locale), `${locale} no lo acepta el checkout`).toBe(locale);
    }
    // Y al revés: nada que el perfil rechace se cuela por aquí.
    for (const locale of ['pt-BR', 'en-GB', 'fr-FR']) {
      expect((ALLOWED_LOCALES as readonly string[]).includes(locale), locale).toBe(false);
      expect(sanitizeCheckoutLocale(locale), locale).toBeUndefined();
    }
  });

  it('el idioma de referencia del producto es uno de los aceptados', () => {
    // Si dejara de serlo, el camino degradado (omitir el campo → default de BD)
    // dejaría de coincidir con lo que el resto del producto llama «español».
    expect(sanitizeCheckoutLocale(HUB_DEFAULT_LOCALE)).toBe(HUB_DEFAULT_LOCALE);
  });
});
