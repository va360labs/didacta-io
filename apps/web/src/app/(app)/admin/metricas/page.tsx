'use client';

/**
 * Redirect de compatibilidad: /admin/metricas → /admin?tab=negocio.
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
    router.replace('/admin?tab=negocio');
  }, [router]);
  return null;
}
