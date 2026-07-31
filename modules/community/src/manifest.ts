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
  coreVersionRequired: '^1.0.0',
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
    optionalModules: [{ name: 'mod.courses', version: '^1.0.0' }],
  },
  eventsEmitted: [
    'community.post.created',
    'community.comment.created',
    'community.reaction.added',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/community',
});
