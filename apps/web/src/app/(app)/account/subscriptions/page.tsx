'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Redirect de compatibilidad: /account/subscriptions → /account?tab=suscripcion.
 *
 * La gestión de suscripciones ahora vive como pestaña en /account (antes esta
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
    router.replace(`/account?tab=suscripcion${suffix}`);
  }, [router, params]);

  return null;
}
