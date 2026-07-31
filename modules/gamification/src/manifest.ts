/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.gamification',
  displayName: 'Puntos y retos',
  description:
    'Convierte la actividad de la comunidad en un libro de puntos auditable: reglas configurables, niveles con beneficio y retos con prueba obligatoria.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  // A propósito NO es 'core': un tenant puede desactivar los puntos.
  category: 'engagement',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_gamification_',
  permissions: ['gamification.read', 'gamification.submit', 'gamification.manage'],
  dependencies: {
    modules: [],
    // Lectura acotada para el relleno del histórico (ADR-016): posts y
    // comentarios de mod.community, matrículas completadas de mod.learning y
    // recursos compartidos de mod.resources. Solo lectura, nunca escritura.
    optionalModules: [
      { name: 'mod.community', version: '^1.0.0' },
      { name: 'mod.learning', version: '^1.0.0' },
      { name: 'mod.resources', version: '^1.0.0' },
    ],
  },
  eventsEmitted: [
    'gamification.points.awarded',
    'gamification.points.revoked',
    'gamification.level.changed',
    'gamification.challenge.submitted',
    'gamification.challenge.reviewed',
    'gamification.perk.requested',
    'gamification.perk.handled',
  ],
  eventsConsumed: [
    'community.post.created',
    'community.comment.created',
    'community.post.hidden',
    'community.post.unhidden',
    'community.comment.hidden',
    'community.comment.unhidden',
    'resources.resource.created',
    'resources.resource.deleted',
    'learning.course.completed',
    'referrals.referral.attributed',
  ],
  apiNamespace: '/modules/gamification',
});
