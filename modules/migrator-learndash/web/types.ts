/**
 * Tipos del shape `ModuleWebExtension` esperado por apps/web del host.
 * Si el host evoluciona, estos tipos se actualizarán.
 */
import type { ComponentType } from 'react';

export interface ModuleSidebarItem {
  label: string;
  icon: string;
  href: string;
  surface: 'admin' | 'formador' | 'alumno' | 'auditor' | 'empresa_manager';
  requiredCapability?: string;
  badge?: { text: string; variant: 'default' | 'success' | 'warning' | 'destructive' };
}

export interface ModuleAdminConfigTab {
  id: string;
  label: string;
  href: string;
}

export interface ModuleRoute {
  path: string;
  Component: ComponentType<unknown>;
  surface: 'admin' | 'formador' | 'alumno' | 'auditor' | 'empresa_manager';
  requiredCapability?: string;
}

export interface ModuleWebExtension {
  name: string;
  sidebarItems?: ModuleSidebarItem[];
  adminConfigTabs?: ModuleAdminConfigTab[];
  routes?: ModuleRoute[];
}
