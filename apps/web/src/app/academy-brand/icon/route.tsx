/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ImageResponse } from 'next/og';
import { publicHost } from '@/lib/academy-locale';
import {
  BRAND_IMAGE_CACHE,
  brandArt,
  IconArt,
  redirectToOwnImage,
} from '@/lib/academy-brand-image';
import { fetchPublicBrandCached } from '@/lib/seo-server';

/**
 * FAVICON del aula del dominio (lo enlaza el layout raíz en todas las páginas):
 *
 *  1. Su favicon, si lo subió en Marca.
 *  2. Si no, su logo.
 *  3. Si no tiene ninguno, sus iniciales sobre su color, generadas aquí (PNG).
 *     Nunca el logo de Didacta (decisión de Valentín, 14-nov-2026).
 *
 * `?size=180` es el icono de iOS (sin esquinas: las pone el sistema).
 */

export const dynamic = 'force-dynamic';

const SIZES = new Set([16, 32, 48, 64, 128, 180, 192, 256, 512]);
const DEFAULT_SIZE = 64;

export async function GET(request: Request): Promise<Response> {
  const requested = Number(new URL(request.url).searchParams.get('size'));
  const size = SIZES.has(requested) ? requested : DEFAULT_SIZE;
  const brand = await fetchPublicBrandCached(
    publicHost(request.headers),
    request.headers.get('x-forwarded-for'),
  );
  const own =
    redirectToOwnImage(brand?.faviconUrl ?? null) ?? redirectToOwnImage(brand?.logoUrl ?? null);
  if (own) return own;
  return new ImageResponse(<IconArt art={brandArt(brand)} size={size} rounded={size !== 180} />, {
    width: size,
    height: size,
    headers: { 'cache-control': BRAND_IMAGE_CACHE },
  });
}
