import { describe, expect, it } from 'vitest';
import { ADMIN_BACK_LINK, buildAdminGroups, buildGroups } from '@/lib/sidebar-nav';
import { moduleExtensions } from '@/modules';
import type { SidebarGroup } from '@/components/app-sidebar';
import esNav from '@/i18n/messages/es/nav.json';
import enNav from '@/i18n/messages/en/nav.json';
import ptNav from '@/i18n/messages/pt/nav.json';

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

  it('todo grupo core tiene key en es, en y pt', () => {
    for (const g of groups) {
      expect(esNav.groups, `falta es nav.groups["${g}"]`).toHaveProperty([g]);
      expect(enNav.groups, `falta en nav.groups["${g}"]`).toHaveProperty([g]);
      expect(ptNav.groups, `falta pt nav.groups["${g}"]`).toHaveProperty([g]);
    }
  });

  it('todo item core tiene key en es, en y pt', () => {
    for (const it of items) {
      expect(esNav.items, `falta es nav.items["${it}"]`).toHaveProperty([it]);
      expect(enNav.items, `falta en nav.items["${it}"]`).toHaveProperty([it]);
      expect(ptNav.items, `falta pt nav.items["${it}"]`).toHaveProperty([it]);
    }
  });

  it('es, en y pt tienen exactamente las mismas keys (sin huérfanas)', () => {
    expect(Object.keys(esNav.groups).sort()).toEqual(Object.keys(enNav.groups).sort());
    expect(Object.keys(esNav.items).sort()).toEqual(Object.keys(enNav.items).sort());
    expect(Object.keys(esNav.groups).sort()).toEqual(Object.keys(ptNav.groups).sort());
    expect(Object.keys(esNav.items).sort()).toEqual(Object.keys(ptNav.items).sort());
  });

  it('el menú portugués no es el español con otro nombre', () => {
    // Las keys de `nav` son los tokens en español, así que un `pt/nav.json`
    // copiado de `es/` pasaría los tres tests de arriba. Algunos rótulos sí se
    // escriben igual («Cursos», «Agenda»); la inmensa mayoría no.
    const iguales = Object.entries(ptNav.items).filter(([k, v]) => v === k).length;
    expect(iguales).toBeLessThan(Object.keys(ptNav.items).length / 4);
  });

  it('el catálogo es-ES es identidad (el token ES el copy español)', () => {
    for (const [k, v] of Object.entries(esNav.groups)) expect(v).toBe(k);
    for (const [k, v] of Object.entries(esNav.items)) expect(v).toBe(k);
  });
});
