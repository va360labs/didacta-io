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
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_learning_',
  permissions: [
    'learning.enrollment.read',
    'learning.enrollment.write',
    'learning.progress.read',
    'learning.progress.write',
  ],
  dependencies: {
    modules: [{ name: 'mod.courses', version: '^1.0.0' }],
    optionalModules: [],
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
