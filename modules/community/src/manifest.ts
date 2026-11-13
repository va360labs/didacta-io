/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.community',
  displayName: 'Comunidad',
  description:
    'Posts, comentarios y reacciones por tenant, opcionalmente vinculados a un curso. Sin moderación ni nested replies en v0.1.',
  version: '0.1.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^0.1.0',
  tablePrefix: 'mod_community_',
  permissions: [
    'community.post.read',
    'community.post.write',
    'community.comment.read',
    'community.comment.write',
    'community.reaction.write',
  ],
  dependencies: {
    modules: [],
    // Lectura (nunca escritura) de la barra lateral del feed, por `tenant_id`
    // (ADR-016): el ranking de los puntos, la presencia del aula y la marca.
    optionalModules: [
      { name: 'mod.courses', version: '^1.0.0' },
      { name: 'mod.gamification', version: '^1.0.0' },
      { name: 'mod.messaging', version: '^1.0.0' },
      { name: 'mod.theming', version: '^0.1.0' },
    ],
  },
  eventsEmitted: [
    'community.post.created',
    'community.comment.created',
    'community.reaction.added',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/community',
});
