/**
 * Guard de INTEGRIDAD del árbol de navegación.
 *
 * `mergeExtensionSidebarItems` inserta cada `sidebarItem` de un módulo en el
 * grupo cuyo label coincide con su `group:`, y si ese grupo no existe hace
 * `continue` — el item desaparece SIN ERROR. Combinado con que
 * `buildAdminGroups` crea unos grupos u otros según el rol, eso produce
 * features en producción que nadie puede alcanzar.
 *
 * Caso real (2026-07-30): `mod.gamification` declaraba
 * `group: 'Administración', requiresRole: 'tenant_admin'`, pero el grupo
 * 'Administración' del área admin solo se crea si `isSuperAdmin`. Resultado:
 * el panel de puntos y retos era invisible justo para el rol al que estaba
 * destinado. El guard anti-huérfanas no lo veía porque solo comprueba que el
 * `href:` aparezca escrito en algún archivo, no que el grupo destino exista.
 *
 * Este test cierra ese agujero: para CADA item de extensión y CADA rol que
 * debería verlo, el grupo destino tiene que existir en la navegación de ese rol.
 */

import { describe, it, expect } from 'vitest';
import type { SidebarGroup } from '@/components/app-sidebar';
import { buildGroups, buildAdminGroups } from '@/lib/sidebar-nav';
import { moduleExtensions } from '@/modules';

/** Grupo de espacios: lo inyecta el Shell desde la API; para el test basta vacío. */
const ESPACIOS: SidebarGroup = { label: 'Foros', icon: 'hash', collapsible: true, items: [] };

type Role = 'alumno' | 'formador' | 'tenant_admin' | 'super_admin';
const ROLES: Role[] = ['alumno', 'formador', 'tenant_admin', 'super_admin'];

/**
 * Todos los labels de grupo que un rol puede llegar a ver, sumando el menú
 * principal y —si es admin— el área de administración, que lo reemplaza al
 * entrar en /admin.
 */
function visibleGroupLabels(role: Role): Set<string> {
  const isAdminOrFormador = role !== 'alumno';
  const isAdmin = role === 'tenant_admin' || role === 'super_admin';
  const isSuperAdmin = role === 'super_admin';

  const labels = new Set<string>();
  for (const g of buildGroups({ isAdminOrFormador, isAdmin, isSuperAdmin, espacios: ESPACIOS })) {
    labels.add(g.label);
  }
  if (isAdmin) {
    for (const g of buildAdminGroups({ isSuperAdmin })) labels.add(g.label);
  }
  return labels;
}

/**
 * Misma jerarquía que `roleCanSee` en `sidebar-extensions-merge.ts`:
 * super_admin ve todo; el resto, match exacto. Sin `requiresRole`, lo ve todo
 * el mundo (incluido un alumno).
 */
function roleShouldSee(role: Role, requiresRole: string | undefined): boolean {
  if (!requiresRole) return true;
  if (role === 'super_admin') return true;
  return role === requiresRole;
}

describe('integridad del árbol de navegación', () => {
  it('ningún módulo declara un grupo inexistente para el rol al que apunta', () => {
    const labelsByRole = new Map(ROLES.map((r) => [r, visibleGroupLabels(r)]));
    const broken: string[] = [];

    for (const ext of moduleExtensions) {
      for (const item of ext.sidebarItems ?? []) {
        for (const role of ROLES) {
          if (!roleShouldSee(role, item.requiresRole)) continue;
          if (labelsByRole.get(role)!.has(item.group)) continue;
          broken.push(
            `${ext.name} → "${item.label}" (${item.href}) declara group='${item.group}', ` +
              `que NO existe en la navegación de un ${role}` +
              (item.requiresRole
                ? ` (requiresRole='${item.requiresRole}')`
                : ' (sin requiresRole)'),
          );
        }
      }
    }

    expect(
      broken,
      'Items de módulo que el merge descarta en silencio (grupo destino inexistente ' +
        'para ese rol). O el módulo apunta al grupo equivocado, o el grupo debe ' +
        'existir para ese rol en sidebar-nav.ts:\n  ' +
        broken.join('\n  '),
    ).toEqual([]);
  });

  it('los grupos del área admin no se solapan con los del menú principal', () => {
    // Un mismo label en ambos árboles haría que un item de módulo apareciese en
    // los dos sitios (o en el equivocado). 'Gestión' vs 'Administración' existe
    // justamente para evitarlo.
    const main = new Set(
      buildGroups({
        isAdminOrFormador: true,
        isAdmin: true,
        isSuperAdmin: true,
        espacios: ESPACIOS,
      }).map((g) => g.label),
    );
    const admin = buildAdminGroups({ isSuperAdmin: true }).map((g) => g.label);
    const overlap = admin.filter((l) => main.has(l));
    expect(
      overlap,
      `Labels duplicados entre el menú principal y el área admin: ${overlap.join(', ')}`,
    ).toEqual([]);
  });

  it('ningún grupo del área admin supera los 6 items del core', () => {
    // Techo deliberado: por encima de ~6 el grupo deja de escanearse y se
    // convierte en el cajón de sastre que era "General" (14 items).
    const tooBig = buildAdminGroups({ isSuperAdmin: true })
      .filter((g) => g.items.length > 6)
      .map((g) => `${g.label} (${g.items.length})`);
    expect(tooBig, `Grupos demasiado grandes: ${tooBig.join(', ')}`).toEqual([]);
  });
});
