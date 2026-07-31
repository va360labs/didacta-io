/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point del módulo `mod.certificates` hacia el core.
///
/// El catálogo agrega 2 sidebar items: `/mis-certificados` (alumno,
/// grupo Aprendizaje) y `/formador/certificados/templates` (formador).

import type { ModuleWebExtension } from '@/lib/module-registry';

export const certificatesExtension: ModuleWebExtension = {
  name: 'mod.certificates',
  sidebarItems: [
    {
      group: 'Aprendizaje',
      href: '/mis-certificados',
      label: 'Mis certificados',
      icon: 'award',
    },
    {
      group: 'Formador',
      href: '/formador/certificados/templates',
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
