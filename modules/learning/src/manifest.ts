/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.learning',
  displayName: 'Aprendizaje',
  description:
    'Matriculación, progreso por lección y reglas de finalización (umbral configurable, default 75%).',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^0.0.1',
  tablePrefix: 'mod_learning_',
  permissions: [
    'learning.enrollment.read',
    'learning.enrollment.write',
    'learning.progress.read',
    'learning.progress.write',
  ],
  dependencies: {
    modules: [{ name: 'mod.courses', version: '^1.0.0' }],
    // DRIP: lectura cross-table first-party (ADR-016) del tier efectivo
    // (mod.payment-connections) y de la membresía de grupos (mod.access-groups)
    // para resolver a qué alumno aplica un calendario de drip. Solo lectura,
    // filtrada por tenant_id. Si el módulo no está activo, no hay drip de ese tipo.
    // mod.subscriptions: lectura del estado TRIALING de la membresía + su
    // trialLessonLimit para el gate de contenido del periodo de prueba.
    optionalModules: [
      { name: 'mod.payment-connections', version: '^1.0.0' },
      { name: 'mod.access-groups', version: '^1.0.0' },
      { name: 'mod.subscriptions', version: '^1.0.0' },
    ],
  },
  eventsEmitted: [
    'learning.enrollment.created',
    'learning.enrollment.cancelled',
    'learning.progress.updated',
    'learning.course.completed',
    'learning.invitation.created',
  ],
  eventsConsumed: ['courses.course.archived'],
  apiNamespace: '/modules/learning',
});
