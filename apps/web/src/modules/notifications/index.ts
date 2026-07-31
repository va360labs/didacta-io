/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point del módulo `mod.notifications`.
///
/// alpha.83 — el tab "Plantillas" de /admin/configuracion se consolidó en la
/// sección dedicada `/admin/emails` (regla #5: un solo camino al mismo
/// destino), que ahora cubre el catálogo COMPLETO de emails del producto
/// (transaccionales + hub). El tab "Notificaciones · SMTP" sigue viviendo en
/// el core porque SMTP es infraestructura compartida (auth/password reset,
/// billing, etc. también lo usan).

import type { ModuleWebExtension } from '@/lib/module-registry';

export const notificationsExtension: ModuleWebExtension = {
  name: 'mod.notifications',
  adminConfigTabs: [],
};

export {
  adminNotificationsApi,
  type EmailTemplateCatalogEntry,
  type EmailTemplateCategory,
  type EmailTemplateVariable,
  type NotificationChannel,
  type NotificationTemplateOverride,
} from './admin-client';
export { EmailTemplatesManager, NotificationTemplatesTab } from './admin-templates-card';
