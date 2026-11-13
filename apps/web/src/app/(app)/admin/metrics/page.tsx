'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Redirect de compatibilidad: /admin/metrics → /admin?tab=business.
 *
 * Las métricas del negocio son ahora una pestaña del panel: tener dos
 * dashboards con entrada propia obligaba a adivinar cuál abrir. La ruta se
 * conserva para enlaces guardados y marcadores.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminMetricasRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin?tab=business');
  }, [router]);
  return null;
}
