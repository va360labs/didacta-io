'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Redirect de compatibilidad: /admin/integraciones/api → /admin/api-keys?tab=docs.
 *
 * La documentación en vivo para integradores es ahora una pestaña de Claves
 * API: era una página sin entrada de menú, a la que solo se llegaba por un
 * enlace enterrado en la cabecera de esa misma pantalla. La ruta se conserva
 * porque es la que se ha compartido con integradores externos.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function IntegracionApiRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/api-keys?tab=docs');
  }, [router]);
  return null;
}
