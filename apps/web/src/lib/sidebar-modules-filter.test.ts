import { describe, expect, it } from 'vitest';
import type { SidebarGroup } from '@/components/app-sidebar';
import { filterByActiveModules } from './sidebar-modules-filter';

const sample: SidebarGroup[] = [
  {
    label: 'Aprendizaje',
    items: [
      { href: '/courses', label: 'Catálogo', icon: 'book' },
      { href: '/community', label: 'Comunidad', icon: 'users', requiresModule: 'mod.community' },
      { href: '/notifications', label: 'Notificaciones', icon: 'bell' },
    ],
  },
  {
    label: 'Formador',
    items: [
      {
        href: '/studio/live',
        label: 'Aula virtual',
        icon: 'calendar',
        requiresModule: 'mod.zoom-live',
      },
    ],
  },
];

describe('filterByActiveModules', () => {
  it('devuelve los grupos sin tocar mientras activeModules es null (carga pendiente)', () => {
    const result = filterByActiveModules(sample, null);
    expect(result).toBe(sample);
    expect(result[0].items).toHaveLength(3);
  });

  it('oculta items con requiresModule cuyo módulo no está en activeModules', () => {
    const result = filterByActiveModules(sample, new Set(['mod.courses']));
    expect(result[0].items.map((i) => i.label)).toEqual(['Catálogo', 'Notificaciones']);
  });

  it('mantiene items con requiresModule cuando el módulo está activo', () => {
    const result = filterByActiveModules(sample, new Set(['mod.community']));
    expect(result[0].items.map((i) => i.label)).toEqual([
      'Catálogo',
      'Comunidad',
      'Notificaciones',
    ]);
  });

  it('elimina grupos enteros cuando todos sus items se filtran', () => {
    const result = filterByActiveModules(sample, new Set(['mod.community']));
    // Formador tenía 1 item con requiresModule mod.zoom-live → grupo desaparece.
    expect(result.find((g) => g.label === 'Formador')).toBeUndefined();
    expect(result).toHaveLength(1);
  });

  it('items sin requiresModule SIEMPRE pasan', () => {
    const result = filterByActiveModules(sample, new Set());
    expect(result[0].items.map((i) => i.label)).toEqual(['Catálogo', 'Notificaciones']);
  });
});

describe('filterByActiveModules · strictModule (entradas que solo existen en algunas instalaciones)', () => {
  const groups: SidebarGroup[] = [
    {
      label: 'Ingresos',
      items: [
        { href: '/admin/membership', label: 'Membresía', icon: 'sparkles' },
        {
          href: '/admin/payments',
          label: 'Cobros',
          icon: 'briefcase',
          requiresModule: 'mod.payouts',
          strictModule: true,
        },
      ],
    },
  ];

  it('mientras no se sabe qué módulos hay (null), NO se pinta', () => {
    expect(filterByActiveModules(groups, null)[0]!.items.map((i) => i.label)).toEqual([
      'Membresía',
    ]);
  });

  it('sin mod.payouts (Community) no aparece; con él, sí', () => {
    expect(filterByActiveModules(groups, new Set())[0]!.items).toHaveLength(1);
    expect(
      filterByActiveModules(groups, new Set(['mod.payouts']))[0]!.items.map((i) => i.label),
    ).toEqual(['Membresía', 'Cobros']);
  });
});
