'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Redirect de compatibilidad: /admin/sso-saml → /admin/sso?tab=saml.
 *
 * Los tres protocolos de SSO se unificaron en una sola pantalla con pestañas.
 * La ruta se conserva para enlaces guardados y documentación ya repartida a
 * clientes con SAML configurado.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminSamlSsoRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/sso?tab=saml');
  }, [router]);
  return null;
}
