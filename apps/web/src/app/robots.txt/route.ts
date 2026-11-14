/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { publicHost } from '@/lib/academy-locale';
import { buildRobotsTxt, canonicalOrigin } from '@/lib/seo';
import { fetchPublicSeo, requestOrigin } from '@/lib/seo-server';

/**
 * `robots.txt` POR AULA: lo decide el dominio de la petición (el middleware ya
 * ha dejado fuera los dominios que no son de nadie y los suspendidos, y el de
 * un sitio público ni llega aquí: se reescribe a su árbol).
 *
 *  - Portada pública encendida: solo la portada, el catálogo y las fichas, y
 *    el sitemap del aula (`buildRobotsTxt`).
 *  - Apagada: se deja rastrear (salvo la API) y manda el `noindex` de cada
 *    página, como antes de que existiera este fichero (ver
 *    `ROBOTS_NOT_INDEXABLE`).
 *  - La API no contesta: 503. Un buscador lo lee como «de momento no rastrees,
 *    vuelve luego», que es justo lo que es; un `Disallow` o un `Allow` por un
 *    fallo pasajero sería mentirle durante el día que lo guarda en caché.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const host = publicHost(request.headers);
  const seo = await fetchPublicSeo(host, request.headers.get('x-forwarded-for'));
  const origin = canonicalOrigin(seo, requestOrigin(request.headers, host));
  if (!seo || !origin) {
    return new Response('Service Unavailable\n', {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '120',
      },
    });
  }
  return new Response(buildRobotsTxt(seo, origin), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
