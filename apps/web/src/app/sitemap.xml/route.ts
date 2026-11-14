/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { publicHost } from '@/lib/academy-locale';
import { buildSitemapXml, canonicalOrigin } from '@/lib/seo';
import { fetchPublicSeo, requestOrigin } from '@/lib/seo-server';

/**
 * `sitemap.xml` POR AULA (el del dominio de la petición): la portada, el
 * catálogo si hay algo a la venta y cada ficha de venta, con su última
 * modificación real. Las URL van con el dominio canónico del aula.
 *
 * Aula sin portada pública → 404 (no hay nada que listar). La API no contesta
 * → 503. Cacheado: la API por aula, este servidor por host y el navegador o
 * proxy cinco minutos.
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
  if (!seo.indexable) {
    return new Response('Not Found\n', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    });
  }
  return new Response(buildSitemapXml(seo, origin), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
