'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PageSkeleton } from '@/components/page-skeleton';
import { resolveHomeLanding } from '@/lib/home-landing';

/**
 * `/home`: el aterrizaje de quien entra sin un destino concreto (login, MFA,
 * SSO, portada con sesión). Decide entre «Empieza aquí» y la comunidad (ver
 * `lib/home-landing.ts`) y, mientras tanto, enseña el esqueleto del aula: antes
 * redirigía desde el servidor y la página se quedaba en blanco hasta que
 * llegaba la comunidad.
 *
 * La sesión vive en el navegador, así que la decisión es del cliente.
 */
export default function InicioPage() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    void resolveHomeLanding().then((path) => {
      if (!cancelled) router.replace(path);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);
  return <PageSkeleton />;
}
