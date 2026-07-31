/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.ai-content',
  displayName: 'Generador IA de contenido formativo',
  description:
    'Genera borradores de resúmenes, flashcards y quizzes desde una lección via AI Gateway. Todo en DRAFT — human-in-the-loop por defecto.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'ai',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_ai_content_',
  permissions: ['ai-content.generate', 'ai-content.review', 'ai-content.read'],
  dependencies: {
    modules: [{ name: 'mod.courses', version: '^1.0.0' }],
    optionalModules: [],
  },
  eventsEmitted: [
    'ai-content.draft.generated',
    'ai-content.draft.published',
    'ai-content.draft.rejected',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/ai-content',
});
