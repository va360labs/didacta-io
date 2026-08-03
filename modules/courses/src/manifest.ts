/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.courses',
  displayName: 'Cursos',
  description: 'Gestión de cursos, módulos y lecciones (catálogo y editor del formador).',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^0.0.1',
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
    'courses.course.unarchived',
    'courses.module.created',
    'courses.module.deleted',
    'courses.lesson.created',
    'courses.lesson.updated',
    'courses.lesson.moved',
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
  dependencies: {
    modules: [],
    // mod.certificates: al actualizar un curso se valida la plantilla de
    // certificado (lectura cross-table de mod_certificates_template — ADR-016,
    // módulo core first-party). Acoplamiento bidireccional con certificates →
    // candidato a romper vía service público en un follow-up.
    optionalModules: [{ name: 'mod.certificates', version: '^1.0.0' }],
  },
  apiNamespace: '/modules/courses',
});
