/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ModuleWebExtension } from '@/lib/module-registry';

/**
 * mod.resources — biblioteca de recursos por colecciones (bloque 4). La
 * sección /recursos cuelga del grupo 'Aprendizaje' del menú principal: es la
 * razón más barata para entrar en el aula ("el recurso está aquí, no en
 * Telegram").
 */
export const resourcesExtension: ModuleWebExtension = {
  name: 'mod.resources',
  sidebarItems: [
    {
      group: 'Aprendizaje',
      href: '/recursos',
      label: 'Recursos',
      icon: 'download-cloud',
    },
  ],
};

// Convención: los consumidores importan SIEMPRE desde '@/modules/resources'.
export {
  resourcesApi,
  type CollectionView,
  type CreateResourceInput,
  type ResourceKind,
  type ResourceView,
} from './client';
export { CollectionFormModal, ShareResourceModal } from './resource-modals';
