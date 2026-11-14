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
 * Vista previa POR DEFECTO al compartir una página de venta del aula que no
 * trae imagen propia (/join): la que sirve `app/academy-brand/og` —su portada,
 * su logo o sus iniciales sobre su color—, nunca la marca de Didacta. La
 * portada, el catálogo y las fichas ponen la suya con el mismo destino.
 *
 * Lleva el dominio de la petición (`headers()`), así que los metadatos de la
 * página pasan a calcularse por petición y Next los envía en streaming (el
 * `<title>` puede llegar en el `<body>`, como ya pasaba en la portada y las
 * fichas). Por eso NO va en el layout raíz ni en pantallas que no se comparten
 * (acceso, cuenta, la app): allí el `<title>` sigue en el `<head>`, donde lo
 * vigila `TenantTitle`. El favicon sí va en la raíz: es una ruta relativa.
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
