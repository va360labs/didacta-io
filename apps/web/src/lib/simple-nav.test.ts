/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import type { SidebarGroup } from '@/components/app-sidebar';
import { mergeExtensionSidebarItems } from '@/lib/sidebar-extensions-merge';
import { buildAdminGroups, buildGroups } from '@/lib/sidebar-nav';
import {
  activeSimpleTab,
  buildSimpleMore,
  buildSimpleTabs,
  mobileTabs,
  reachableInSimpleMode,
} from '@/lib/simple-nav';
import { moduleExtensions } from '@/modules';

const ESPACIOS: SidebarGroup = {
  label: 'Foros',
  items: [{ href: '/spaces/general', label: 'General', icon: 'hash' }],
};

/** Árbol COMPLETO de hoy para un rol, con las extensiones de los módulos. */
function fullTree(roles: string[]): SidebarGroup[] {
  const isAdmin = roles.some((r) => r === 'tenant_admin' || r === 'super_admin');
  const main = buildGroups({
    isAdminOrFormador: isAdmin || roles.includes('formador'),
    isAdmin,
    isSuperAdmin: roles.includes('super_admin'),
    espacios: ESPACIOS,
  });
  const admin = isAdmin ? buildAdminGroups({ isSuperAdmin: roles.includes('super_admin') }) : [];
  return mergeExtensionSidebarItems([...main, ...admin], moduleExtensions, new Set(roles));
}

const TODOS = new Set(['mod.gamification', 'mod.payouts']);

describe('modo sencillo: pestañas', () => {
  it('alumno: 5 pestañas con puntos activados, 4 sin ellos', () => {
    expect(
      buildSimpleTabs({ isAdmin: false, activeModules: TODOS, hasSold: false }).map((t) => t.id),
    ).toEqual(['comunidad', 'cursos', 'directos', 'miembros', 'ranking']);
    expect(
      buildSimpleTabs({ isAdmin: false, activeModules: new Set(), hasSold: false }),
    ).toHaveLength(4);
  });

  it('creador: 7 pestañas; «Empieza aquí» pasa a «Inicio» tras la primera venta', () => {
    const antes = buildSimpleTabs({ isAdmin: true, activeModules: TODOS, hasSold: false });
    expect(antes.map((t) => t.id)).toEqual([
      'empieza',
      'comunidad',
      'cursos',
      'directos',
      'alumnos',
      'ventas',
      'ajustes',
    ]);
    expect(antes[0]?.labelKey).toBe('empieza');
    expect(
      buildSimpleTabs({ isAdmin: true, activeModules: TODOS, hasSold: true })[0]?.labelKey,
    ).toBe('inicio');
  });

  it('Ventas apunta a los cobros de plataforma solo si existen', () => {
    const conCobros = buildSimpleTabs({ isAdmin: true, activeModules: TODOS, hasSold: false });
    const sin = buildSimpleTabs({ isAdmin: true, activeModules: new Set(), hasSold: false });
    expect(conCobros.find((t) => t.id === 'ventas')?.href).toBe('/admin/payments');
    expect(sin.find((t) => t.id === 'ventas')?.href).toBe('/admin/membership');
  });

  it('móvil: 4 pestañas y «Más»', () => {
    const alumno = buildSimpleTabs({ isAdmin: false, activeModules: TODOS, hasSold: false });
    expect(mobileTabs(alumno, false).map((t) => t.id)).toEqual([
      'comunidad',
      'cursos',
      'directos',
      'miembros',
    ]);
    const creador = buildSimpleTabs({ isAdmin: true, activeModules: TODOS, hasSold: false });
    expect(mobileTabs(creador, true).map((t) => t.id)).toEqual([
      'empieza',
      'comunidad',
      'cursos',
      'ventas',
    ]);
  });

  it('pestaña activa por prefijo más largo', () => {
    const tabs = buildSimpleTabs({ isAdmin: true, activeModules: TODOS, hasSold: false });
    expect(activeSimpleTab('/studio/courses/abc', tabs)).toBe('cursos');
    expect(activeSimpleTab('/spaces/general', tabs)).toBe('comunidad');
    expect(activeSimpleTab('/admin/payments', tabs)).toBe('ventas');
    expect(activeSimpleTab('/admin/webhooks', tabs)).toBeNull();
  });
});

describe('modo sencillo: «Más» no pierde nada', () => {
  for (const roles of [['alumno'], ['formador'], ['tenant_admin'], ['super_admin']]) {
    it(`${roles[0]}: toda ruta del menú completo sigue siendo alcanzable`, () => {
      const full = fullTree(roles);
      const isAdmin = roles.some((r) => r === 'tenant_admin' || r === 'super_admin');
      const tabs = buildSimpleTabs({ isAdmin, activeModules: null, hasSold: false });
      const more = buildSimpleMore(full, tabs);
      const reachable = reachableInSimpleMode(tabs, more);
      const perdidas = full
        .filter((g) => g.label !== 'Foros')
        .flatMap((g) => g.items.map((i) => i.href.split('?')[0]!))
        .filter((h) => !reachable.has(h));
      expect(perdidas).toEqual([]);
    });
  }

  it('«Más» no repite las pestañas ni las cosas que viven en la cabecera', () => {
    const full = fullTree(['tenant_admin']);
    const tabs = buildSimpleTabs({ isAdmin: true, activeModules: null, hasSold: false });
    const hrefs = buildSimpleMore(full, tabs).flatMap((g) => g.items.map((i) => i.href));
    for (const h of [
      '/community',
      '/studio/courses',
      '/admin/users',
      '/admin/settings',
      '/community/mentions',
      '/messages',
      '/my-certificates',
    ]) {
      expect(hrefs).not.toContain(h);
    }
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs).toContain('/admin/webhooks');
  });

  it('el creador ve como mucho 7 pestañas y el alumno como mucho 5', () => {
    expect(
      buildSimpleTabs({ isAdmin: true, activeModules: null, hasSold: true }).length,
    ).toBeLessThanOrEqual(7);
    expect(
      buildSimpleTabs({ isAdmin: false, activeModules: null, hasSold: true }).length,
    ).toBeLessThanOrEqual(5);
  });
});
