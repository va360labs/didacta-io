'use client';

/**
 * Redirect de compatibilidad: /cuenta/suscripciones → /cuenta?tab=suscripcion.
 *
 * La gestión de suscripciones ahora vive como pestaña en /cuenta (antes esta
 * era una ruta huérfana sin entrada de menú). Se conserva la ruta porque es el
 * `success_url`/`cancel_url` del checkout de Stripe; preservamos el `?status`
 * para que la pestaña muestre la confirmación del retorno.
 */

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function MisSuscripcionesRedirect() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const status = params.get('status');
    const suffix = status ? `&status=${encodeURIComponent(status)}` : '';
    router.replace(`/cuenta?tab=suscripcion${suffix}`);
  }, [router, params]);

  return null;
}
