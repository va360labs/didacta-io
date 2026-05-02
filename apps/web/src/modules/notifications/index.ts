/// Extension point del módulo `mod.notifications`.
///
/// Hoy solo declara el tab "Plantillas" (override del copy de
/// notificaciones). El tab "Notificaciones · SMTP" sigue viviendo en el
/// core porque SMTP es infraestructura compartida (auth/password reset,
/// billing, etc. también lo usan). Migrar SMTP a su propio
/// `/admin/email` o equivalente queda como follow-up — ADR-011 lo
/// menciona como excepción aceptable mientras varios consumidores
/// dependan de la misma infraestructura.

import type { ModuleWebExtension } from '@/lib/module-registry';
import { NotificationTemplatesTab } from './admin-templates-card';

export const notificationsExtension: ModuleWebExtension = {
  name: 'mod.notifications',
  adminConfigTabs: [
    {
      key: 'plantillas',
      label: 'Plantillas',
      description: 'Override del copy de las notificaciones por canal e idioma.',
      Component: NotificationTemplatesTab,
    },
  ],
};

export {
  adminNotificationsApi,
  type NotificationChannel,
  type NotificationTemplateOverride,
} from './admin-client';
export { NotificationTemplatesTab } from './admin-templates-card';
