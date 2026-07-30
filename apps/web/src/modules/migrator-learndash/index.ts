/// Sidebar item del migrador LearnDash en el shell admin del host.
///
/// alpha.60 (ADR-015): este archivo es lo ÚNICO específico del módulo que
/// queda en `apps/web/`. Solo registra el sidebar item — la UI completa
/// (wizard + monitor + admin config card) vive ahora en
/// `modules/migrator-learndash/src/ui/` y se distribuye dentro del ZIP
/// firmado del módulo.
///
/// El sidebar item apunta a `/admin/integraciones/migrator-learndash`, una
/// page genérica del host que hace `loadModuleUI('mod.migrator-learndash',
/// 'admin')` y renderiza el componente default del bundle.
///
/// DEUDA PENDIENTE: este archivo debería desaparecer cuando el host
/// implemente sidebar discovery runtime-driven leyendo `manifest.surfaces.
/// admin.menu` de cada módulo instalado. Mientras tanto, vive aquí como
/// puente — el sidebar item se registra estático, pero el componente que
/// muestra es 100% del módulo.

import type { ModuleWebExtension } from '@/lib/module-registry';

export const migratorLearndashExtension: ModuleWebExtension = {
  name: 'mod.migrator-learndash',
  sidebarItems: [
    {
      // El sidebar consolidó "Integraciones" dentro de "Administración"
      // (ver buildGroups en (app)/layout.tsx). El merge solo inserta en
      // grupos EXISTENTES, así que apuntar a un grupo inexistente descartaba
      // el item en silencio. Va en "Administración" junto a Marketplace/Tenants.
      group: 'Plataforma',
      href: '/admin/integraciones/migrator-learndash',
      label: 'Migrar desde LearnDash',
      icon: 'download-cloud',
      requiresRole: 'super_admin',
    },
  ],
};
