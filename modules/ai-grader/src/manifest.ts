import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.ai-grader',
  displayName: 'AI Grader · corrección IA con rúbrica',
  description:
    'Corrección IA de respuestas abiertas (SHORT_ANSWER, LONG_ANSWER) usando rúbricas ' +
    'definidas por el formador. La IA propone nota + justificación + feedback; el formador ' +
    'revisa y confirma antes de publicar (human-in-the-loop). Fase 1.C.',
  version: '0.1.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'ai',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_ai_grader_',
  permissions: [
    'ai-grader.rubric.read',
    'ai-grader.rubric.write',
    'ai-grader.suggestion.read',
    'ai-grader.suggestion.write',
  ],
  dependencies: {
    modules: [],
    optionalModules: [{ name: 'mod.assessments', version: '^1.0.0' }],
  },
  eventsEmitted: ['ai-grader.suggestion.generated', 'ai-grader.suggestion.failed'],
  eventsConsumed: [],
  apiNamespace: '/modules/ai-grader',
});
