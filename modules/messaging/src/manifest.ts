/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.messaging',
  displayName: 'Mensajería · salas, directos y canal de profesores',
  description:
    'Mensajería nativa de la comunidad: una sala de chat por cada espacio, mensajes ' +
    'directos entre miembros y canal privado automático de cada alumno con el equipo ' +
    'de profesores. Tiempo real vía SSE. US-M1..M3 del PRD mensajes.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'community',
  coreVersionRequired: '^0.1.0',
  tablePrefix: 'mod_messaging_',
  permissions: [
    'messaging.conversation.read',
    'messaging.message.write',
    'messaging.moderation.write',
  ],
  dependencies: {
    modules: [],
    // ADR-016: lectura cross-table de mod_community_space (salas 1:1 con
    // espacios) — solo lectura, siempre filtrando tenant_id, sin FKs.
    optionalModules: [{ name: 'mod.community', version: '^0.1.0' }],
  },
  eventsEmitted: ['messaging.conversation.created', 'messaging.message.sent'],
  eventsConsumed: [],
  apiNamespace: '/modules/messaging',
});
