/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.ai-tutor',
  displayName: 'AI Tutor · asistente IA por curso',
  description:
    'Tutor IA por curso con RAG sobre el contenido publicado. Indexa al publicar curso, ' +
    'responde dudas del alumno citando las lecciones relevantes. Fase 1.C.',
  version: '0.1.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'ai',
  coreVersionRequired: '^0.0.1',
  tablePrefix: 'mod_ai_tutor_',
  permissions: [
    'ai-tutor.chat.read',
    'ai-tutor.chat.write',
    'ai-tutor.index.write',
    'ai-tutor.config.write',
    // Revisión de respuestas y conocimiento validado.
    'ai-tutor.review.read',
    'ai-tutor.review.write',
  ],
  dependencies: {
    modules: [],
    optionalModules: [
      { name: 'mod.courses', version: '^1.0.0' },
      { name: 'mod.learning', version: '^1.0.0' },
    ],
  },
  eventsEmitted: [
    'ai-tutor.course.indexed',
    'ai-tutor.course.index-failed',
    'ai-tutor.chat.message-sent',
    'ai-tutor.chat.message-received',
    // Revisión humana de las respuestas.
    'ai-tutor.answer.reviewed',
    'ai-tutor.answer.corrected',
  ],
  eventsConsumed: [
    'courses.course.published',
    'courses.course.unpublished',
    // Reindexado por lección: subir una clase o pegar su transcripción la mete
    // en el tutor sin reindexar el curso entero.
    'courses.lesson.created',
    'courses.lesson.updated',
    'courses.lesson.deleted',
  ],
  apiNamespace: '/modules/ai-tutor',
});
