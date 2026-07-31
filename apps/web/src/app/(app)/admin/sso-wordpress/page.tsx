'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Redirect de compatibilidad: /admin/sso-wordpress → /admin/sso?tab=wordpress.
 *
 * Los tres protocolos de SSO se unificaron en una sola pantalla con pestañas.
 * La ruta se conserva para enlaces guardados: es la que se cita en las
 * instrucciones de wp-config.php.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminWpSsoRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/sso?tab=wordpress');
  }, [router]);
  return null;
}
