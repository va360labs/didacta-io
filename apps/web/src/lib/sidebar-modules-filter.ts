import type { SidebarGroup } from '@/components/app-sidebar';

/**
 * Filtra items con `requiresModule` cuando el módulo correspondiente NO está
 * activo en el tenant. Si un grupo queda sin items, también se elimina.
 *
 * Items SIN `requiresModule` quedan intactos. Capabilities EE NO se filtran
 * aquí — esas siguen el patrón EeGate (visible-pero-bloqueado).
 *
 * Mientras `activeModules` sea `null` (carga pendiente) devolvemos los grupos
 * sin tocar — evita que el sidebar parpadee al primer render. El backend
 * sigue protegiendo cada endpoint vía `ModuleAccessInterceptor` aunque el
 * usuario haga clic en un item que estaba caché-stale.
 */
export function filterByActiveModules(
  groups: SidebarGroup[],
  activeModules: Set<string> | null,
): SidebarGroup[] {
  if (activeModules === null) return groups;
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => !it.requiresModule || activeModules.has(it.requiresModule)),
    }))
    .filter((g) => g.items.length > 0);
}
