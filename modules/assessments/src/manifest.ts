import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.assessments',
  displayName: 'Evaluaciones',
  description:
    'Quizzes con opciones únicas, múltiples y verdadero/falso. Auto-corrección de tipos objetivos y umbral de aprobación configurable.',
  version: '0.1.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_assessments_',
  permissions: [
    'assessments.quiz.read',
    'assessments.quiz.write',
    'assessments.quiz.publish',
    'assessments.attempt.create',
    'assessments.attempt.read',
  ],
  dependencies: {
    modules: [{ name: 'mod.courses', version: '^1.0.0' }],
    optionalModules: [{ name: 'mod.learning', version: '^1.0.0' }],
  },
  eventsEmitted: [
    'assessments.quiz.published',
    'assessments.attempt.started',
    'assessments.attempt.submitted',
    'assessments.attempt.pending_review',
    'assessments.attempt.graded',
    'assessments.attempt.passed',
    'assessments.attempt.failed',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/assessments',
});
