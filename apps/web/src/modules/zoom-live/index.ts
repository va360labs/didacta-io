/// Extension point del módulo `mod.zoom-live` hacia el core.
///
/// El catálogo `apps/web/src/modules/index.ts` importa esta constante y la
/// agrega al `moduleExtensions[]`. El core consume el agregado desde
/// `/admin/configuracion`, sidebar, etc. Para añadir una nueva
/// superficie del módulo (ej. una página dedicada del formador), se
/// declara aquí — sin tocar el core.

import type { ModuleWebExtension } from '@/lib/module-registry';
import { ZoomAdminSurface } from './admin-surface';

export const zoomLiveExtension: ModuleWebExtension = {
  name: 'mod.zoom-live',
  adminConfigTabs: [
    {
      key: 'aula-virtual',
      label: 'Aula virtual',
      description: 'Credenciales Zoom Server-to-Server para sesiones síncronas.',
      Component: ZoomAdminSurface,
    },
  ],
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

/// Re-exports del módulo. Los consumidores externos (páginas Next del
/// core que actúan como wrapper) importan el cliente HTTP y los tipos
/// desde `@/modules/zoom-live` — nunca desde `./client` o paths internos.
export { zoomLiveApi } from './client';
export type {
  SessionStatus,
  ZoomSession,
  ZoomSessionRegistration,
  WebhookEventResult,
  ZoomWebhookEventItem,
  PaginatedWebhookEvents,
} from './client';
