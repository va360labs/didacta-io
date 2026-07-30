import type { ComponentType } from 'react';

/// Registry de extensiones de UI aportadas por los módulos al core.
///
/// El core no sabe qué módulos hay — solo importa este registry y renderiza
/// lo que cada módulo declare. Los módulos viven en
/// `apps/web/src/modules/<name>/` y exportan un `ModuleWebExtension` desde
/// su `index.ts`. El catálogo agregado se construye en
/// `apps/web/src/modules/index.ts` (build-time, import estático).
///
/// Una vez el marketplace dinámico esté operativo (PR #54 + sucesores),
/// este patrón se complementa con un loader runtime que lee módulos
/// instalados desde `installed_module` y mounta sus extensions en caliente.
/// La interfaz queda igual — solo cambia el bus de carga.

export interface ModuleAdminConfigTab {
  /// Identificador único en el conjunto de tabs del panel
  /// `/admin/configuracion`. Por convención = slug del módulo sin prefijo
  /// `mod.` (ej. `mod.zoom-live` → `zoom-live`).
  key: string;
  label: string;
  description: string;
  /// Componente React que renderiza el contenido del tab. Se monta solo
  /// cuando el tab está seleccionado (no al render del shell).
  Component: ComponentType;
}

export interface ModuleSidebarItem {
  /// Grupo del sidebar donde insertar el item. DEBE coincidir con un `label`
  /// real de `buildGroups()` o `buildAdminGroups()` en `@/lib/sidebar-nav`, o
  /// el merge lo descarta en silencio.
  ///
  /// Esta unión es la primera línea de defensa (falla en compilación); la
  /// segunda es `sidebar-nav.test.ts`, que además comprueba que el grupo exista
  /// para el ROL que el item exige — un `group` válido puede seguir siendo
  /// inalcanzable, que es justo lo que le pasó a 'Puntos y retos' apuntando a
  /// 'Administración' (grupo solo-super_admin) con `requiresRole:
  /// 'tenant_admin'`.
  group:
    // Menú principal.
    | 'Aprendizaje'
    | 'Personas'
    | 'Formador'
    // Área de administración.
    | 'Personas y accesos'
    | 'Comunidad'
    | 'Contenido'
    | 'Ingresos'
    | 'Comunicación'
    | 'Marca y ajustes'
    | 'Integraciones y API'
    | 'Seguridad'
    | 'Plataforma';
  href: string;
  label: string;
  icon: string;
  /// Solo visible si el rol coincide. Si se omite, visible para todos los
  /// que ven el grupo.
  requiresRole?: 'super_admin' | 'tenant_admin' | 'formador';
  /// Si es `true`, el item se marca activo solo cuando el pathname coincide
  /// EXACTAMENTE con `href` (no por prefijo). Necesario para items "padre"
  /// como `/comunidad` que de otro modo se marcarían activos en rutas hijas
  /// como `/comunidad/menciones`.
  exactMatch?: boolean;
}

export interface ModuleWebExtension {
  /// Slug exacto del módulo (`mod.<slug>`). El core consulta este valor
  /// contra `activeModules` del tenant para decidir si renderizar las
  /// extensions o no.
  name: string;
  /// Tabs adicionales en `/admin/configuracion`.
  adminConfigTabs?: ModuleAdminConfigTab[];
  /// Items adicionales en el sidebar.
  sidebarItems?: ModuleSidebarItem[];
}

/// Helper de filtrado: devuelve solo las extensions cuyos módulos están
/// activos para el tenant. `activeModules=null` indica "loading" — el
/// core debe decidir si mostrar todo (permisivo) o nada (estricto). Por
/// defecto el filtro es permisivo: si la lista no llegó aún, no escondemos
/// nada para no bloquear al admin.
export function filterByActiveModulesOptional(
  extensions: readonly ModuleWebExtension[],
  activeModules: ReadonlySet<string> | null,
): ModuleWebExtension[] {
  if (activeModules === null) return [...extensions];
  return extensions.filter((e) => activeModules.has(e.name));
}
