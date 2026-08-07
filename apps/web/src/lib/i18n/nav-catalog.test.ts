import { describe, expect, it } from 'vitest';
import { ADMIN_BACK_LINK, buildAdminGroups, buildGroups } from '@/lib/sidebar-nav';
import { moduleExtensions } from '@/modules';
import type { SidebarGroup } from '@/components/app-sidebar';
import esNav from '@/i18n/messages/es/nav.json';
import enNav from '@/i18n/messages/en/nav.json';

/**
 * Guarda del contrato sidebar ↔ i18n.
 *
 * Los `label`/`group` de sidebar-nav.ts y de los manifests de módulos son
 * TOKENS canónicos (string-match en mergeExtensionSidebarItems, que descarta
 * en silencio lo que no casa). app-sidebar traduce solo la PRESENTACIÓN vía
 * `nav.groups.*` / `nav.items.*` con fallback al token. Este test convierte
 * "grupo/item core sin traducción" — que en runtime sería un menú a medias en
 * inglés — en un fallo de CI.
 */

const ESPACIOS_STUB: SidebarGroup = { label: 'Foros', icon: 'hash', items: [] };

function collectCoreTokens(): { groups: Set<string>; items: Set<string> } {
  const groups = new Set<string>();
  const items = new Set<string>();
  const trees = [
    buildGroups({
      isAdminOrFormador: true,
      isSuperAdmin: true,
      isAdmin: true,
      espacios: ESPACIOS_STUB,
    }),
    buildGroups({
      isAdminOrFormador: false,
      isSuperAdmin: false,
      isAdmin: false,
      espacios: ESPACIOS_STUB,
    }),
    buildAdminGroups({ isSuperAdmin: true }),
  ];
  for (const tree of trees) {
    for (const g of tree) {
      groups.add(g.label);
      for (const it of g.items) items.add(it.label);
    }
  }
  items.add(ADMIN_BACK_LINK.label);
  // Extensiones de módulos first-party in-tree: sus group/label también son
  // producto y deben tener traducción (un ZIP third-party cae al fallback raw).
  for (const ext of moduleExtensions) {
    for (const it of ext.sidebarItems ?? []) {
      groups.add(it.group);
      items.add(it.label);
    }
  }
  return { groups, items };
}

describe('catálogo nav ↔ árbol de navegación real', () => {
  const { groups, items } = collectCoreTokens();

  it('todo grupo core tiene key en es y en', () => {
    for (const g of groups) {
      expect(esNav.groups, `falta es nav.groups["${g}"]`).toHaveProperty([g]);
      expect(enNav.groups, `falta en nav.groups["${g}"]`).toHaveProperty([g]);
    }
  });

  it('todo item core tiene key en es y en', () => {
    for (const it of items) {
      expect(esNav.items, `falta es nav.items["${it}"]`).toHaveProperty([it]);
      expect(enNav.items, `falta en nav.items["${it}"]`).toHaveProperty([it]);
    }
  });

  it('es y en tienen exactamente las mismas keys (sin huérfanas)', () => {
    expect(Object.keys(esNav.groups).sort()).toEqual(Object.keys(enNav.groups).sort());
    expect(Object.keys(esNav.items).sort()).toEqual(Object.keys(enNav.items).sort());
  });

  it('el catálogo es-ES es identidad (el token ES el copy español)', () => {
    for (const [k, v] of Object.entries(esNav.groups)) expect(v).toBe(k);
    for (const [k, v] of Object.entries(esNav.items)) expect(v).toBe(k);
  });
});
