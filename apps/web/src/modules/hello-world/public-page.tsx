/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ModulePublicRouteProps } from '@/lib/module-registry';

/**
 * Página pública del módulo de referencia.
 *
 * Es un componente de SERVIDOR a propósito: lo que demuestra esta superficie
 * es que el contenido de un módulo llega en el HTML, sin ejecutar JavaScript
 * y sin sesión. Si esto necesitase hidratarse para verse, la superficie no
 * serviría para lo que existe.
 *
 * No usa `'use client'`, no lee cookies y no llama a ningún endpoint
 * autenticado. Esas tres cosas son el contrato, no un detalle de esta página.
 */
export function HelloWorldPublicPage({ site, pathname }: ModulePublicRouteProps) {
  return (
    <main style={{ padding: '3rem 1.5rem', maxWidth: '48rem', margin: '0 auto' }}>
      <h1>Hola desde un módulo</h1>
      <p>
        Esta página la sirve <code>mod.hello-world</code> en la superficie pública, renderizada en
        el servidor.
      </p>
      <dl>
        <dt>Sitio</dt>
        <dd data-testid="site-name">{site.tenantName}</dd>
        <dt>Dominio</dt>
        <dd data-testid="site-hostname">{site.hostname}</dd>
        <dt>Origen canónico</dt>
        <dd data-testid="site-origin">{site.origin}</dd>
        <dt>Ruta</dt>
        <dd data-testid="route-pathname">{pathname}</dd>
      </dl>
    </main>
  );
}
