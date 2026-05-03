/**
 * Frontend del módulo migrator-learndash.
 *
 * Este punto de entrada se carga en `apps/web/src/modules/index.ts` del
 * host (federation manual). Devuelve un `ModuleWebExtension` que añade:
 *  - sidebarItem: enlace al wizard en el panel admin.
 *  - adminConfigTab: opcional, panel de configuración del módulo.
 */
import { wizardRoute } from './components/Wizard.js';
import type { ModuleWebExtension } from './types.js';

export const migratorLearndashExtension: ModuleWebExtension = {
  name: 'mod.migrator-learndash',
  sidebarItems: [
    {
      label: 'Migrar desde LearnDash',
      icon: 'download-cloud',
      href: '/admin/modules/migrator-learndash',
      surface: 'admin',
      requiredCapability: 'feat:migrators.learndash',
      badge: { text: 'Nuevo', variant: 'success' },
    },
  ],
  adminConfigTabs: [
    {
      id: 'migrator-learndash-history',
      label: 'Historial de migraciones',
      href: '/admin/modules/migrator-learndash/history',
    },
  ],
  routes: [wizardRoute],
};

export default migratorLearndashExtension;
export * from './lib/api-client.js';
export * from './components/Wizard.js';
export * from './components/steps/index.js';
