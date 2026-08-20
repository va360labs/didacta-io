/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { flatPublicRoutes } from '@/modules';
import { selectPublicRoute } from '@/lib/public-route-match';
import { getSiteContext } from '@/lib/site-context';
import { publicPathnameFromSegments } from '@/lib/site-routing';

/**
 * Punto de entrada del sitio público.
 *
 * El middleware ya ha decidido que este dominio sirve el sitio, pero **aquí se
 * vuelve a resolver**. No es desconfianza gratuita: en Next el layout y la
 * página se renderizan en paralelo, así que un paso anterior no es una
 * garantía sobre lo que esta página tiene derecho a leer. El middleware
 * reparte; la autorización es de quien sirve el dato.
 *
 * Todo lo de este árbol se renderiza en SERVIDOR y sin sesión: es contenido
 * que tiene que estar en el HTML para poder indexarse.
 */

interface PageProps {
  params: Promise<{ ruta?: string[] }>;
}

async function resolve(params: PageProps['params']) {
  const { ruta } = await params;
  const pathname = publicPathnameFromSegments(ruta);

  const headerList = await headers();
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host');
  const site = await getSiteContext(host);
  if (!site) return null;

  // Solo se montan las rutas de los módulos ACTIVOS en este tenant. Un módulo
  // presente en el repo pero apagado no publica nada.
  const active = new Set(site.activeModules);
  const candidates = flatPublicRoutes()
    .filter(({ moduleName }) => active.has(moduleName))
    .map(({ route }) => route);

  const hit = selectPublicRoute(candidates, pathname);
  if (!hit) return null;

  return { site, pathname, hit };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolved = await resolve(params);
  if (!resolved) return {};

  const { site, pathname } = resolved;
  const canonical = new URL(pathname, site.origin).toString();

  // El canonical sale del origen del sitio, que se deriva del dominio de
  // entrada. Por eso mover el sitio a otro dominio es cambiar una fila: no hay
  // ningún host escrito en el repositorio del que haya que acordarse.
  return {
    metadataBase: new URL(site.origin),
    alternates: { canonical },
    openGraph: { url: canonical, siteName: site.tenantName },
  };
}

export default async function SitioPage({ params }: PageProps) {
  const resolved = await resolve(params);
  if (!resolved) notFound();

  const { site, pathname, hit } = resolved;
  const { Component } = hit.route;

  return <Component pathname={pathname} params={hit.params} site={site} />;
}
