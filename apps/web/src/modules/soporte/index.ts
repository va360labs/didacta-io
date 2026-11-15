/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point de `mod.soporte` («Ayuda y sugerencias»): tickets de los
/// miembros para el equipo del aula (fallos, problemas y sugerencias).
///
///  - El botón «Ayuda y sugerencias» va al pie del menú lateral (modo
///    completo) y en la cabecera (modo sencillo). Lo pinta el armazón con
///    `SoporteButton`, que solo sale con el módulo encendido.
///  - «Tus tickets» vive en `/support` (se llega desde el propio botón, la
///    campana y el correo de cambio de estado).
///  - La bandeja del equipo, `/admin/support`, entra en el grupo
///    «Comunicación» del área de administración. En el modo sencillo aparece
///    una sola vez en «Más» (lo construye `buildSimpleMore` a partir de este
///    mismo árbol). `requiresRole: 'tenant_admin'` deja fuera a formador y
///    moderador (super_admin lo ve todo); el merge le añade
///    `requiresModule: 'mod.soporte'`, así que solo aparece con el módulo
///    encendido.

import type { ModuleWebExtension } from '@/lib/module-registry';

export const soporteExtension: ModuleWebExtension = {
  name: 'mod.soporte',
  sidebarItems: [
    {
      group: 'Comunicación',
      href: '/admin/support',
      label: 'Tickets de soporte',
      icon: 'help',
      requiresRole: 'tenant_admin',
    },
  ],
};

/// Re-exports: los consumidores del core importan SIEMPRE desde
/// `@/modules/soporte`, nunca desde ficheros internos.
export { SoporteButton } from './soporte-button';
export { SoporteDialog } from './soporte-dialog';
export { TusTickets } from './tus-tickets';
export { AdminSoporte } from './admin-soporte';
export { soporteApi } from './client';
export type { AdminTicketView, TicketView } from './client';
