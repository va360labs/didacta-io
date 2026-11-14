/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { publicHost } from './academy-locale';
import { ACADEMY_OG_PATH } from './academy-mark';
import { requestOrigin } from './seo-server';

/**
 * Vista previa POR DEFECTO al compartir una página del aula que no trae imagen
 * propia (/join, el acceso, la solicitud de acceso): la que sirve
 * `app/academy-brand/og` —su portada, su logo o sus iniciales sobre su color—,
 * nunca la marca de Didacta.
 *
 * Va en el `generateMetadata` de cada página y NO en el layout raíz a
 * propósito: un `generateMetadata` en la raíz hace dinámicos (en streaming) los
 * metadatos de TODAS las páginas, y el `<title>` de pantallas como /calendar
 * se quedaba pintado en el `<body>` (lo cazó `redesign-smoke`). El favicon sí va
 * en la raíz: es una ruta relativa, no necesita el dominio.
 */
export async function academyOgDefaults(): Promise<Metadata> {
  const h = await headers();
  const origin = requestOrigin(h, publicHost(h));
  if (!origin) return {};
  return {
    metadataBase: new URL(origin),
    openGraph: { images: [{ url: ACADEMY_OG_PATH }] },
    twitter: { card: 'summary_large_image', images: [ACADEMY_OG_PATH] },
  };
}
