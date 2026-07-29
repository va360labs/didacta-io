import type { ModuleWebExtension } from '@/lib/module-registry';

/**
 * mod.resources — biblioteca de recursos (bloque 4). La sección /recursos
 * cuelga del grupo 'Aprendizaje' del menú principal: es la razón más barata
 * para entrar en el aula ("el recurso está aquí, no en Telegram").
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
  RESOURCE_CATEGORY_LABELS,
  type CreateResourceInput,
  type ResourceCategory,
  type ResourceKind,
  type ResourceView,
} from './client';
