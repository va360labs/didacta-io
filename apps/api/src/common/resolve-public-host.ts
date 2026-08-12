/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { RequestLike } from './resolve-web-base-url';

/**
 * El host PÚBLICO del request: el que tecleó la persona, no el del último salto.
 *
 * Didacta se despliega con el web (Next) como única puerta pública y la API
 * detrás: `next.config.mjs` reescribe `/api/:path*` hacia `API_INTERNAL_URL`
 * (`http://localhost:4000`). En ese salto **Next reemplaza `Host` por el del
 * destino** y pone el original en `x-forwarded-host`.
 *
 * Por eso el orden importa, y estaba al revés: leer `req.headers.host` primero
 * devuelve SIEMPRE `localhost:4000` en producción, y el `?? x-forwarded-host`
 * que venía detrás era código muerto —`host` nunca falta—. Con eso, toda la
 * multi-tenencia por hostname resolvía al tenant dueño de `localhost`, que en
 * una instalación nueva es el primero que se creó: el aula de un cliente
 * enseñaba la marca y las cifras de otro, y un alta pública aterrizaba en el
 * tenant equivocado.
 *
 * `resolveWebBaseUrl` (misma carpeta) ya lo hacía bien desde el principio. Esto
 * es la misma cascada, extraída para que haya UNA sola forma de preguntarlo.
 *
 * Sobre confiar en `x-forwarded-host`: es una cabecera que el cliente puede
 * poner, sí — pero `Host` también, y `resolveByHost` siempre se apoyó en ella.
 * No hay privilegio nuevo aquí: elegir tenant por cabecera solo cambia qué
 * superficie PÚBLICA se ve; entrar sigue exigiendo credenciales de ese tenant.
 * Traefik reescribe `X-Forwarded-*` para clientes no confiables, así que en el
 * despliegue de Didacta el valor viene del proxy, no del visitante.
 */
export function resolvePublicHost(req: RequestLike): string | undefined {
  const forwarded = firstValue(req.headers['x-forwarded-host']);
  if (forwarded) return forwarded;
  return firstValue(req.headers['host']);
}

/**
 * Primer valor útil de una cabecera.
 *
 * Dos formas de venir en plural, y las dos pasan: repetida (Fastify la entrega
 * como array) o encadenada por varios proxies en una sola línea
 * (`a.example, b.internal`). En ambos casos el bueno es el PRIMERO — el que
 * puso el proxy más cercano al visitante.
 */
function firstValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const first = (raw.split(',')[0] ?? raw).trim();
  return first.length > 0 ? first : undefined;
}
