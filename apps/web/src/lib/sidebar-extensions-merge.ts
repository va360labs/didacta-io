/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
 *  - Jerarquía de roles: `super_admin` es el rol máximo y VE TODOS los items
 *    (misma convención que el core con `isAdminOrFormador`/`isSuperAdmin`).
 *    Sin esto, un super_admin "puro" (sin tenant_admin en sus roles) no veía
 *    items de extensión gateados a tenant_admin/formador — p.ej. Fundae,
 *    Billing, AI Grader, Aula virtual. El resto de roles sigue siendo match
 *    exacto (un tenant_admin NO ve items de formador, y viceversa).
 *  - Dedupe defensiva por `(group, href)`: si el grupo ya tiene un item con
 *    el mismo href (hardcoded del core, otra extension), la extension nueva
 *    se ignora silenciosamente. Garantiza "un href, un origen" — evita la
 *    duplicación visual que dispara el bug de "Aula virtual" duplicada.
 *
 * Mutación: este merger MUTA `groups` en sitio. El caller debe pasar copias
 * frescas si necesita inmutabilidad.
 */
/**
 * ¿Puede un usuario con `userRoles` ver un item gateado a `required`?
 * `super_admin` ve todo (rol máximo). El resto, match exacto — preserva la
 * separación tenant_admin / formador.
 */
function roleCanSee(userRoles: Set<string>, required: string): boolean {
  if (userRoles.has('super_admin')) return true;
  return userRoles.has(required);
}

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
      if (item.requiresRole && !roleCanSee(userRoles, item.requiresRole)) continue;

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
