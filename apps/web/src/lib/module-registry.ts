/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ComponentType } from 'react';
import { labelOr, type TranslatorLike } from '@/lib/i18n/labels';

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

/// Texto de PANTALLA aportado por un módulo.
///
/// Un módulo no puede llamar a `useTranslations` desde su `index.ts` (es un
/// objeto a nivel de módulo, sin hooks), así que declara el par
/// `{ key, fallback }` y el core lo resuelve con `resolveModuleText`. Los
/// módulos del repo apuntan a una key real del catálogo del core; un módulo
/// de terceros que no esté en el catálogo pinta su `fallback` — nunca la key.
///
/// OJO: esto NO aplica a `ModuleSidebarItem.label`/`group`, que son tokens
/// canónicos del contrato de navegación (en español, sin traducir) y se
/// traducen aguas abajo contra `nav.items.*` / `nav.groups.*`.
export interface ModuleLocalizedText {
  /// Key del catálogo, relativa al namespace que use el consumidor del core
  /// (para `adminConfigTabs`, el namespace `adminMarca`).
  key: string;
  /// Valor crudo que se pinta si la key no existe en el catálogo activo.
  fallback: string;
}

export interface ModuleAdminConfigTab {
  /// Identificador único en el conjunto de tabs del panel
  /// `/admin/configuracion`. Por convención = slug del módulo sin prefijo
  /// `mod.` (ej. `mod.zoom-live` → `zoom-live`).
  key: string;
  label: ModuleLocalizedText;
  description: ModuleLocalizedText;
  /// Componente React que renderiza el contenido del tab. Se monta solo
  /// cuando el tab está seleccionado (no al render del shell).
  Component: ComponentType;
}

/// Resuelve un `ModuleLocalizedText` contra el catálogo del core.
///
/// CAMINO DEGRADADO (intencionado, con test en `module-registry.test.ts`): si
/// la key no está en el catálogo del idioma activo se devuelve el `fallback`
/// declarado por el módulo. Nunca se devuelve la key: un `t()` directo pintaría
/// `configTabs.lo-que-sea` en pantalla para cualquier módulo de terceros.
export function resolveModuleText(t: TranslatorLike, text: ModuleLocalizedText): string {
  return labelOr(t, text.key, text.fallback);
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
  group: // Menú principal.
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

/// Props que recibe el componente de una ruta pública.
export interface ModulePublicRouteProps {
  /// Ruta pedida, ya normalizada (siempre empieza por `/`, sin barra final).
  pathname: string;
  /// Parámetros capturados por el patrón (`/blog/:slug` → `{ slug: '...' }`).
  /// Un patrón catch-all (`/:resto*`) deja el resto en un solo valor.
  params: Readonly<Record<string, string>>;
  /// Contexto del sitio resuelto por dominio, SIN sesión.
  site: PublicSiteContext;
}

/// Lo que el core sabe del sitio antes de renderizar nada de un módulo.
/// Sale de `GET /api/v1/public/site-context`, que resuelve por dominio.
export interface PublicSiteContext {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  hostname: string;
  /// Origen canónico del sitio, derivado del dominio de entrada. TODA URL
  /// absoluta que emita el sitio (canonical, Open Graph, sitemap, enlaces de
  /// correo) sale de aquí. Nunca de una variable de entorno global: es un
  /// único valor por instancia y mentiría en cuanto haya dos dominios.
  origin: string;
  activeModules: readonly string[];
}

/// Una ruta pública aportada por un módulo.
///
/// Se renderiza en SERVIDOR, sin sesión y bajo un dominio del tenant marcado
/// como sitio (`TenantDomainSurface.SITE`). Es la única superficie que ve un
/// visitante anónimo, así que su componente no puede depender de un usuario
/// autenticado.
export interface ModulePublicRoute {
  /// Patrón de ruta. Formas admitidas:
  ///   - estático:   `/`, `/precios`
  ///   - parámetro:  `/blog/:slug`
  ///   - catch-all:  `/:ruta*`  (captura el resto, incluidas las barras)
  /// El orden de declaración NO decide: siempre gana el patrón más
  /// específico (ver `selectPublicRoute`).
  pattern: string;
  /// Componente de servidor que renderiza la ruta.
  Component: ComponentType<ModulePublicRouteProps>;
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
  /// Rutas del sitio público (superficie `publico`). Solo se montan si el
  /// dominio de entrada sirve el sitio y el módulo está activo en el tenant.
  publicRoutes?: ModulePublicRoute[];
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
