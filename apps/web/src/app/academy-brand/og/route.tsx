/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ImageResponse } from 'next/og';
import { publicHost } from '@/lib/academy-locale';
import { BRAND_IMAGE_CACHE, brandArt, OgArt, redirectToOwnImage } from '@/lib/academy-brand-image';
import { fetchPublicBrandCached } from '@/lib/seo-server';

/**
 * Imagen POR DEFECTO para redes (`og:image`) del aula del dominio, la que sale
 * al compartir un enlace suyo que no trae imagen propia:
 *
 *  1. Su portada, si la tiene.
 *  2. Si no, su logo.
 *  3. Si no, una imagen 1200×630 con sus iniciales y su nombre sobre su color,
 *     generada aquí. Nunca la marca de Didacta.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const host = publicHost(request.headers);
  const brand = await fetchPublicBrandCached(host, request.headers.get('x-forwarded-for'));
  const own =
    redirectToOwnImage(brand?.coverUrl ?? null) ?? redirectToOwnImage(brand?.logoUrl ?? null);
  if (own) return own;
  const shownHost = host && !/^(localhost|127\.|\[)/.test(host) ? host.split(':')[0]! : null;
  return new ImageResponse(<OgArt art={brandArt(brand)} host={brand ? shownHost : null} />, {
    width: 1200,
    height: 630,
    headers: { 'cache-control': BRAND_IMAGE_CACHE },
  });
}
