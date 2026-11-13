/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { IconName } from '@/components/icon';
import type { SidebarGroup, SidebarItem } from '@/components/app-sidebar';

/**
 * Navegación del MODO SENCILLO (aulas de Didacta Cloud).
 *
 * En vez de la barra lateral con grupos, unas pocas pestañas arriba (abajo en
 * el móvil): 5 para el alumno, 7 para quien administra. Todo lo demás queda en
 * «Más», que se construye a partir del árbol COMPLETO (`buildGroups` y
 * `buildAdminGroups` ya fusionados con las extensiones de los módulos): así
 * ninguna función se pierde y los grupos-contrato de los módulos no se
 * renombran. Funciones puras: ver `simple-nav.test.ts`.
 *
 * Los `label` de las pestañas son claves de `modoSencillo.tabs.*`.
 */

export interface SimpleTab {
  id: SimpleTabId;
  href: string;
  /** Clave en `modoSencillo.tabs`. */
  labelKey: string;
  icon: IconName;
  /** Rutas que marcan esta pestaña como activa (prefijo). */
  matches: string[];
}

export type SimpleTabId =
  | 'empieza'
  | 'comunidad'
  | 'cursos'
  | 'directos'
  | 'miembros'
  | 'ranking'
  | 'alumnos'
  | 'ventas'
  | 'ajustes';

/** Destinos del menú del avatar (perfil, certificados, progreso, referidos). */
export const SIMPLE_AVATAR_LINKS = {
  profile: '/account',
  certificates: '/my-certificates',
  progress: '/home/dashboard',
  referrals: '/referrals',
  notifications: '/notifications',
  messages: '/messages',
} as const;

/**
 * Rutas que en modo sencillo viven en otro sitio y por eso NO se repiten en
 * «Más»: las menciones están en la campanita, los mensajes en la cabecera, los
 * retos dentro del ranking, los certificados en el curso y en el avatar.
 */
const ABSORBED = new Set<string>([
  '/community/mentions',
  '/messages',
  '/challenges',
  '/my-certificates',
  '/home/dashboard',
  '/referrals',
]);

/** Grupos que no van a «Más» porque ya son otra cosa en modo sencillo. */
const ABSORBED_GROUPS = new Set<string>(['Foros']);

export interface SimpleNavInput {
  /** Administra el aula (tenant_admin o super_admin). */
  isAdmin: boolean;
  /** Módulos activos; `null` mientras no se sabe (se asume activo). */
  activeModules: ReadonlySet<string> | null;
  /** Ya tiene al menos una venta: «Empieza aquí» pasa a ser «Inicio». */
  hasSold: boolean;
}

function active(mods: ReadonlySet<string> | null, name: string): boolean {
  return mods === null || mods.has(name);
}

export function buildSimpleTabs({ isAdmin, activeModules, hasSold }: SimpleNavInput): SimpleTab[] {
  if (!isAdmin) {
    const tabs: SimpleTab[] = [
      {
        id: 'comunidad',
        href: '/community',
        labelKey: 'comunidad',
        icon: 'message',
        matches: ['/community', '/spaces'],
      },
      {
        id: 'cursos',
        href: '/courses',
        labelKey: 'cursos',
        icon: 'book',
        matches: ['/courses', '/paths'],
      },
      {
        id: 'directos',
        href: '/calendar',
        labelKey: 'directos',
        icon: 'video',
        matches: ['/calendar', '/events', '/live'],
      },
      {
        id: 'miembros',
        href: '/members',
        labelKey: 'miembros',
        icon: 'users',
        matches: ['/members', '/u'],
      },
    ];
    // El ranking solo existe si la academia usa puntos (mod.gamification).
    if (active(activeModules, 'mod.gamification')) {
      tabs.push({
        id: 'ranking',
        href: '/leaderboard',
        labelKey: 'ranking',
        icon: 'trophy',
        matches: ['/leaderboard', '/challenges'],
      });
    }
    return tabs;
  }
  // Ventas: con cobros de plataforma (Didacta Cloud) es la pantalla de cobros;
  // sin ellos (Community con claves propias), la de la membresía, que es donde
  // se ponen precios y se ve quién paga.
  const ventasHref = activeModules?.has('mod.payouts') ? '/admin/payments' : '/admin/membership';
  return [
    {
      id: 'empieza',
      href: '/start',
      labelKey: hasSold ? 'inicio' : 'empieza',
      icon: hasSold ? 'home' : 'target',
      matches: ['/start'],
    },
    {
      id: 'comunidad',
      href: '/community',
      labelKey: 'comunidad',
      icon: 'message',
      matches: ['/community', '/spaces'],
    },
    {
      id: 'cursos',
      href: '/studio/courses',
      labelKey: 'cursos',
      icon: 'book',
      matches: ['/studio/courses', '/courses'],
    },
    {
      id: 'directos',
      href: '/studio/live',
      labelKey: 'directos',
      icon: 'video',
      matches: ['/studio/live', '/calendar', '/live'],
    },
    {
      id: 'alumnos',
      href: '/admin/users',
      labelKey: 'alumnos',
      icon: 'users',
      matches: ['/admin/users', '/members'],
    },
    {
      id: 'ventas',
      href: ventasHref,
      labelKey: 'ventas',
      icon: 'briefcase',
      matches: [ventasHref, '/admin/payments', '/admin/membership'],
    },
    {
      id: 'ajustes',
      href: '/admin/settings',
      labelKey: 'ajustes',
      icon: 'cog',
      matches: ['/admin/settings', '/admin/branding'],
    },
  ];
}

/** Pestañas de la barra inferior del móvil (la quinta es siempre «Más»). */
export function mobileTabs(tabs: SimpleTab[], isAdmin: boolean): SimpleTab[] {
  if (!isAdmin) return tabs.filter((t) => t.id !== 'ranking').slice(0, 4);
  const want: SimpleTabId[] = ['empieza', 'comunidad', 'cursos', 'ventas'];
  return want.map((id) => tabs.find((t) => t.id === id)).filter((t): t is SimpleTab => Boolean(t));
}

function pathOf(href: string): string {
  return href.split('?')[0] ?? href;
}

function matchesPath(pathname: string, prefix: string): boolean {
  const p = pathOf(prefix);
  return pathname === p || pathname.startsWith(`${p}/`);
}

/** Pestaña activa para una ruta: la de prefijo más largo. `null` = ninguna. */
export function activeSimpleTab(pathname: string, tabs: SimpleTab[]): SimpleTabId | null {
  let best: { id: SimpleTabId; len: number } | null = null;
  for (const tab of tabs) {
    for (const m of tab.matches) {
      if (matchesPath(pathname, m) && (!best || m.length > best.len))
        best = { id: tab.id, len: m.length };
    }
  }
  return best?.id ?? null;
}

/**
 * «Más»: todo lo del árbol completo que no es una pestaña ni vive en la
 * cabecera o el avatar. Sin duplicados (un item de módulo puede aparecer en
 * los dos árboles) y sin grupos vacíos.
 */
export function buildSimpleMore(fullGroups: SidebarGroup[], tabs: SimpleTab[]): SidebarGroup[] {
  const tabHrefs = new Set(tabs.map((t) => pathOf(t.href)));
  const seen = new Set<string>();
  const out: SidebarGroup[] = [];
  for (const group of fullGroups) {
    if (ABSORBED_GROUPS.has(group.label)) continue;
    const items: SidebarItem[] = [];
    for (const item of group.items) {
      const href = pathOf(item.href);
      if (tabHrefs.has(href) || ABSORBED.has(href) || seen.has(href)) continue;
      seen.add(href);
      items.push(item);
    }
    if (items.length > 0) out.push({ label: group.label, icon: group.icon, items });
  }
  return out;
}

/** Todas las rutas a las que se llega en modo sencillo (pestañas, cabecera, avatar y «Más»). */
export function reachableInSimpleMode(tabs: SimpleTab[], more: SidebarGroup[]): Set<string> {
  const all = new Set<string>([
    ...tabs.map((t) => pathOf(t.href)),
    ...Object.values(SIMPLE_AVATAR_LINKS),
    ...ABSORBED,
  ]);
  for (const g of more) for (const i of g.items) all.add(pathOf(i.href));
  return all;
}
