/// Extension point del módulo `mod.migrator-learndash` hacia el core.
///
/// El catálogo `apps/web/src/modules/index.ts` importa esta constante y la
/// agrega al `moduleExtensions[]`. El módulo expone:
///   - Un sidebar item bajo "Integraciones" para super_admin que abre el wizard.
///   - Una tab en `/admin/configuracion` con el resumen del módulo + acceso al wizard.
///
/// La página real del wizard (multi-paso, conecta-preflight-opciones-dryrun-execute)
/// vive en `apps/web/src/app/admin/integraciones/migrator-learndash/page.tsx`.
/// Esa page es un wrapper Next que importa `MigratorWizard` de este módulo.

import type { ModuleWebExtension } from '@/lib/module-registry';
import { MigratorAdminCard } from './admin-config-card';

export const migratorLearndashExtension: ModuleWebExtension = {
  name: 'mod.migrator-learndash',
  adminConfigTabs: [
    {
      key: 'migrator-learndash',
      label: 'Migrar desde LearnDash',
      description:
        'Importa cursos, lecciones, alumnos, grupos y matrículas desde una instalación WordPress + LearnDash.',
      Component: MigratorAdminCard,
    },
  ],
  sidebarItems: [
    {
      group: 'Integraciones',
      href: '/admin/integraciones/migrator-learndash',
      label: 'Migrar desde LearnDash',
      icon: 'download-cloud',
      requiresRole: 'super_admin',
    },
  ],
};

export { migratorLearndashApi } from './client';
export { MigratorAdminCard } from './admin-config-card';
export { MigratorWizard } from './wizard';
