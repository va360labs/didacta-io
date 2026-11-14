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
 * Sin cookie (quien entra por primera vez: la página de venta, el catálogo,
 * /join, el acceso…), el idioma del AULA del dominio (`lib/academy-locale.ts`);
 * si tampoco, español. Ver `resolveRequestLocale`.
 *
 * La timezone del request se fija determinista para SSR; la timezone REAL del
 * usuario (perfil) la aplican los helpers de `@/lib/i18n/format` en cliente.
 */

import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { getAcademyLocale, publicHost } from '@/lib/academy-locale';
import {
  catalogOf,
  isUsableLocaleCookie,
  LOCALE_COOKIE,
  resolveRequestLocale,
  type MessageCatalog,
} from './config';
import en from './messages/en';
import es from './messages/es';
import pt from './messages/pt';

/**
 * Un catálogo por cada entrada de `MESSAGE_CATALOGS`. El `satisfies` es lo que
 * impide declarar un catálogo en `config.ts` y olvidarse de cargarlo aquí: sin
 * él, `CATALOGS[catalogOf(locale)]` daría `undefined` en runtime y next-intl
 * pintaría las keys crudas.
 */
const CATALOGS = { es, en, pt } as const satisfies Record<MessageCatalog, unknown>;

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookie = store.get(LOCALE_COOKIE)?.value;
  // Solo se pregunta a la API cuando la cookie no decide.
  const academy = isUsableLocaleCookie(cookie)
    ? null
    : await getAcademyLocale(publicHost(await headers()));
  const locale = resolveRequestLocale(cookie, academy);
  return {
    locale,
    messages: CATALOGS[catalogOf(locale)],
    timeZone: 'Europe/Madrid',
  };
});
