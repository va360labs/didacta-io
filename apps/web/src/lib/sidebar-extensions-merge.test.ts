import { describe, expect, it } from 'vitest';
import type { SidebarGroup } from '@/components/app-sidebar';
import type { ModuleWebExtension } from '@/lib/module-registry';
import { mergeExtensionSidebarItems } from './sidebar-extensions-merge';

function makeGroups(): SidebarGroup[] {
  return [
    {
      label: 'Formador',
      items: [
        { href: '/formador', label: 'Panel', icon: 'home' },
        { href: '/formador/cursos', label: 'Mis cursos', icon: 'book' },
      ],
    },
    {
      label: 'Integraciones y API',
      items: [{ href: '/admin/webhooks', label: 'Webhooks API', icon: 'package' }],
    },
  ];
}

describe('mergeExtensionSidebarItems', () => {
  it('inserta items declarados por una extension en el grupo correspondiente', () => {
    const ext: ModuleWebExtension = {
      name: 'mod.zoom-live',
      sidebarItems: [
        {
          group: 'Formador',
          href: '/formador/aula-virtual',
          label: 'Aula virtual',
          icon: 'calendar',
        },
      ],
    };
    const result = mergeExtensionSidebarItems(makeGroups(), [ext], new Set(['formador']));
    const formador = result.find((g) => g.label === 'Formador')!;
    expect(formador.items.map((i) => i.href)).toEqual([
      '/formador',
      '/formador/cursos',
      '/formador/aula-virtual',
    ]);
    expect(formador.items.at(-1)?.requiresModule).toBe('mod.zoom-live');
  });

  it('REGRESIÓN: dedupe por (group, href) — un hardcoded + extension con el mismo href no se duplica', () => {
    const groups: SidebarGroup[] = [
      {
        label: 'Formador',
        items: [
          {
            href: '/formador/aula-virtual',
            label: 'Aula virtual',
            icon: 'calendar',
            requiresModule: 'mod.zoom-live',
          },
        ],
      },
    ];
    const ext: ModuleWebExtension = {
      name: 'mod.zoom-live',
      sidebarItems: [
        {
          group: 'Formador',
          href: '/formador/aula-virtual',
          label: 'Aula virtual',
          icon: 'calendar',
        },
      ],
    };
    const result = mergeExtensionSidebarItems(groups, [ext], new Set(['formador']));
    const formador = result.find((g) => g.label === 'Formador')!;
    // Solo UN item con ese href, no duplicado.
    const matches = formador.items.filter((i) => i.href === '/formador/aula-virtual');
    expect(matches).toHaveLength(1);
  });

  it('REGRESIÓN: dedupe entre dos extensions que declaran el mismo href', () => {
    const a: ModuleWebExtension = {
      name: 'mod.a',
      sidebarItems: [{ group: 'Integraciones y API', href: '/x', label: 'A', icon: 'package' }],
    };
    const b: ModuleWebExtension = {
      name: 'mod.b',
      sidebarItems: [{ group: 'Integraciones y API', href: '/x', label: 'B', icon: 'package' }],
    };
    const result = mergeExtensionSidebarItems(makeGroups(), [a, b], new Set([]));
    const integraciones = result.find((g) => g.label === 'Integraciones y API')!;
    const matches = integraciones.items.filter((i) => i.href === '/x');
    expect(matches).toHaveLength(1);
    // Gana el primero (mod.a).
    expect(matches[0].requiresModule).toBe('mod.a');
  });

  it('respeta requiresRole=super_admin', () => {
    const ext: ModuleWebExtension = {
      name: 'mod.migrator',
      sidebarItems: [
        {
          group: 'Integraciones y API',
          href: '/admin/integraciones/migrator-learndash',
          label: 'Migrar desde LearnDash',
          icon: 'download-cloud',
          requiresRole: 'super_admin',
        },
      ],
    };
    const noSuper = mergeExtensionSidebarItems(makeGroups(), [ext], new Set(['tenant_admin']));
    expect(
      noSuper
        .find((g) => g.label === 'Integraciones y API')!
        .items.find((i) => i.href === '/admin/integraciones/migrator-learndash'),
    ).toBeUndefined();

    const withSuper = mergeExtensionSidebarItems(makeGroups(), [ext], new Set(['super_admin']));
    expect(
      withSuper
        .find((g) => g.label === 'Integraciones y API')!
        .items.find((i) => i.href === '/admin/integraciones/migrator-learndash'),
    ).toBeDefined();
  });

  it('REGRESIÓN: respeta requiresRole=formador (antes solo se filtraba super_admin)', () => {
    const ext: ModuleWebExtension = {
      name: 'mod.zoom-live',
      sidebarItems: [
        {
          group: 'Formador',
          href: '/formador/aula-virtual',
          label: 'Aula virtual',
          icon: 'calendar',
          requiresRole: 'formador',
        },
      ],
    };
    const tenantAdminOnly = mergeExtensionSidebarItems(
      makeGroups(),
      [ext],
      new Set(['tenant_admin']),
    );
    expect(
      tenantAdminOnly
        .find((g) => g.label === 'Formador')!
        .items.find((i) => i.href === '/formador/aula-virtual'),
    ).toBeUndefined();

    const formador = mergeExtensionSidebarItems(makeGroups(), [ext], new Set(['formador']));
    expect(
      formador
        .find((g) => g.label === 'Formador')!
        .items.find((i) => i.href === '/formador/aula-virtual'),
    ).toBeDefined();
  });

  it('REGRESIÓN: super_admin VE items gateados a tenant_admin y formador (jerarquía)', () => {
    // Bug reportado: módulos activos (Fundae=tenant_admin) no salían en el menú
    // para un super_admin "puro". super_admin es el rol máximo → ve todo.
    const exts: ModuleWebExtension[] = [
      {
        name: 'mod.fundae',
        sidebarItems: [
          {
            group: 'Integraciones y API',
            href: '/admin/fundae',
            label: 'Fundae',
            icon: 'file',
            requiresRole: 'tenant_admin',
          },
        ],
      },
      {
        name: 'mod.zoom-live',
        sidebarItems: [
          {
            group: 'Formador',
            href: '/formador/aula-virtual',
            label: 'Aula virtual',
            icon: 'calendar',
            requiresRole: 'formador',
          },
        ],
      },
    ];
    const asSuper = mergeExtensionSidebarItems(makeGroups(), exts, new Set(['super_admin']));
    expect(
      asSuper
        .find((g) => g.label === 'Integraciones y API')!
        .items.find((i) => i.href === '/admin/fundae'),
    ).toBeDefined();
    expect(
      asSuper
        .find((g) => g.label === 'Formador')!
        .items.find((i) => i.href === '/formador/aula-virtual'),
    ).toBeDefined();
  });

  it('items SIN requiresRole pasan para todos los roles', () => {
    const ext: ModuleWebExtension = {
      name: 'mod.x',
      sidebarItems: [{ group: 'Integraciones y API', href: '/x', label: 'X', icon: 'package' }],
    };
    const result = mergeExtensionSidebarItems(makeGroups(), [ext], new Set());
    expect(
      result.find((g) => g.label === 'Integraciones y API')!.items.find((i) => i.href === '/x'),
    ).toBeDefined();
  });

  it('propaga exactMatch al item mergeado solo cuando viene en true', () => {
    const ext: ModuleWebExtension = {
      name: 'mod.community',
      sidebarItems: [
        {
          group: 'Formador',
          href: '/comunidad',
          label: 'Comunidad',
          icon: 'users',
          exactMatch: true,
        },
        { group: 'Formador', href: '/comunidad/menciones', label: 'Menciones', icon: 'message' },
      ],
    };
    const result = mergeExtensionSidebarItems(makeGroups(), [ext], new Set());
    const formador = result.find((g) => g.label === 'Formador')!;
    expect(formador.items.find((i) => i.href === '/comunidad')?.exactMatch).toBe(true);
    // El item hijo no lo lleva → undefined (no se inyecta false).
    expect(
      formador.items.find((i) => i.href === '/comunidad/menciones')?.exactMatch,
    ).toBeUndefined();
  });

  it('ignora items cuyo grupo no existe', () => {
    const ext: ModuleWebExtension = {
      name: 'mod.x',
      // 'Inexistente' no es un grupo válido
      sidebarItems: [{ group: 'Inexistente' as never, href: '/x', label: 'X', icon: 'package' }],
    };
    const before = makeGroups();
    const result = mergeExtensionSidebarItems(before, [ext], new Set());
    const totalItems = result.reduce((acc, g) => acc + g.items.length, 0);
    const beforeItems = before.reduce((acc, g) => acc + g.items.length, 0);
    expect(totalItems).toBe(beforeItems);
  });
});
