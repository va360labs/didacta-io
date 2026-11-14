/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point del módulo `mod.retention` (mensajes automáticos y
/// miembros en riesgo). En el modo completo aporta su pestaña en
/// `/admin/settings`; en el modo sencillo la misma sección va dentro de
/// «Ajustes» y el panel de riesgo se abre desde «Alumnos» (`/admin/users/at-risk`).

import type { ModuleWebExtension } from '@/lib/module-registry';
import { AutomatedMessagesTab } from './automated-messages';

export const retentionExtension: ModuleWebExtension = {
  name: 'mod.retention',
  adminConfigTabs: [
    {
      key: 'automated-messages',
      label: { key: 'configTabs.automated-messages', fallback: 'Mensajes automáticos' },
      description: {
        key: 'configTabsDesc.automated-messages',
        fallback: 'Bienvenida, primera semana, recuperación y más, firmados por el aula.',
      },
      Component: AutomatedMessagesTab,
    },
  ],
};

/// Re-exports: los consumidores del core importan SIEMPRE desde
/// `@/modules/retention`, nunca desde ficheros internos.
export { AutomatedMessages } from './automated-messages';
export { AtRiskMembers } from './at-risk-members';
export { AtRiskCard } from './at-risk-card';
export { retentionApi } from './client';
export type { AtRiskResult, AtRiskRow, Automation, RetentionTemplate } from './client';
