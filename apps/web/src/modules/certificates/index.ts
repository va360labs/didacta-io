/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point del módulo `mod.certificates` hacia el core.
///
/// El catálogo agrega 2 sidebar items: `/my-certificates` (alumno,
/// grupo Aprendizaje) y `/studio/certificates/templates` (formador).

import type { ModuleWebExtension } from '@/lib/module-registry';

export const certificatesExtension: ModuleWebExtension = {
  name: 'mod.certificates',
  sidebarItems: [
    {
      group: 'Aprendizaje',
      href: '/my-certificates',
      label: 'Mis certificados',
      icon: 'award',
    },
    {
      group: 'Formador',
      href: '/studio/certificates/templates',
      label: 'Plantillas certificado',
      icon: 'award',
      requiresRole: 'formador',
    },
  ],
};

export {
  certificatesApi,
  certificateTemplatesApi,
  type Certificate,
  type CertificateTemplate,
  type CertificateTemplateInput,
  type PublicCertificateView,
} from './client';
