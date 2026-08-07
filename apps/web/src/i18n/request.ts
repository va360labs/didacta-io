/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Config de request de next-intl (descubierta vía `createNextIntlPlugin()` en
 * next.config.mjs). El idioma se resuelve por cookie — no hay segmento
 * [locale] en las rutas — y por tanto TODAS las rutas pasan a render dinámico
 * (trade-off aceptado: app autenticada de nodo único).
 *
 * La timezone del request se fija determinista para SSR; la timezone REAL del
 * usuario (perfil) la aplican los helpers de `@/lib/i18n/format` en cliente.
 */

import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { catalogOf, LOCALE_COOKIE, toSupportedLocale } from './config';
import en from './messages/en';
import es from './messages/es';

const CATALOGS = { es, en } as const;

export default getRequestConfig(async () => {
  const store = await cookies();
  const locale = toSupportedLocale(store.get(LOCALE_COOKIE)?.value);
  return {
    locale,
    messages: CATALOGS[catalogOf(locale)],
    timeZone: 'Europe/Madrid',
  };
});
