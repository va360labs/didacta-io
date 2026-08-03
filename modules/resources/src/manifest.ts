/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.resources',
  displayName: 'Biblioteca de recursos',
  description:
    'Recursos de la comunidad organizados y buscables: workflows de las clases, skills, directorio de herramientas de IA y plantillas.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  // No es 'core' a propósito: un tenant puede desactivar la biblioteca.
  category: 'engagement',
  coreVersionRequired: '^0.0.1',
  tablePrefix: 'mod_resources_',
  permissions: ['resources.read', 'resources.manage'],
  dependencies: { modules: [], optionalModules: [] },
  eventsEmitted: [
    'resources.resource.created',
    'resources.resource.deleted',
    'resources.collection.created',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/resources',
});
