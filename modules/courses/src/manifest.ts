import { parseModuleManifest, type ModuleManifest } from '@learnship/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.courses',
  displayName: 'Cursos',
  description: 'Gestión de cursos, módulos y lecciones (catálogo y editor del formador).',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_courses_',
  permissions: [
    'courses.course.read',
    'courses.course.write',
    'courses.course.publish',
    'courses.course.archive',
  ],
  eventsEmitted: [
    'courses.course.created',
    'courses.course.updated',
    'courses.course.published',
    'courses.course.archived',
    'courses.module.created',
    'courses.lesson.created',
  ],
  eventsConsumed: [],
  hooksExposed: [
    {
      name: 'courses.publish.validate',
      description:
        'Permite que otros módulos añadan validaciones antes de publicar un curso (ej. mod.fundae verifica objetivos y duración).',
      async: true,
    },
  ],
  apiNamespace: '/modules/courses',
});
