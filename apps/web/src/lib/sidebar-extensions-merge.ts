import type { IconName } from '@/components/icon';
import type { SidebarGroup, SidebarItem } from '@/components/app-sidebar';
import type { ModuleWebExtension } from '@/lib/module-registry';

/**
 * Mergea los `sidebarItems` declarados por cada módulo en `moduleExtensions`
 * a los grupos existentes. Cada item se inserta en el grupo cuyo `label`
 * coincide con el `group` del item. Si el grupo no existe, el item se ignora
 * silenciosamente.
 *
 * El merge añade automáticamente `requiresModule: extension.name` a cada item,
 * de modo que `filterByActiveModules` los oculta cuando el módulo no está
 * activo para el tenant.
 *
 * Garantías:
 *  - Respeta `requiresRole` para CUALQUIER rol (`super_admin`,
 *    `tenant_admin`, `formador`), no solo super_admin.
 *  - Dedupe defensiva por `(group, href)`: si el grupo ya tiene un item con
 *    el mismo href (hardcoded del core, otra extension), la extension nueva
 *    se ignora silenciosamente. Garantiza "un href, un origen" — evita la
 *    duplicación visual que dispara el bug de "Aula virtual" duplicada.
 *
 * Mutación: este merger MUTA `groups` en sitio. El caller debe pasar copias
 * frescas si necesita inmutabilidad.
 */
export function mergeExtensionSidebarItems(
  groups: SidebarGroup[],
  extensions: readonly ModuleWebExtension[],
  userRoles: Set<string>,
): SidebarGroup[] {
  const groupByLabel = new Map(groups.map((g) => [g.label, g]));

  const seenByGroupHref = new Set<string>();
  for (const group of groups) {
    for (const item of group.items) {
      seenByGroupHref.add(`${group.label}::${item.href}`);
    }
  }

  for (const ext of extensions) {
    for (const item of ext.sidebarItems ?? []) {
      if (item.requiresRole && !userRoles.has(item.requiresRole)) continue;

      const group = groupByLabel.get(item.group);
      if (!group) continue;

      const dedupeKey = `${item.group}::${item.href}`;
      if (seenByGroupHref.has(dedupeKey)) continue;
      seenByGroupHref.add(dedupeKey);

      const sidebarItem: SidebarItem = {
        href: item.href,
        label: item.label,
        icon: item.icon as IconName,
        requiresModule: ext.name,
        ...(item.exactMatch ? { exactMatch: true } : {}),
      };
      group.items.push(sidebarItem);
    }
  }

  return groups;
}
