import { parseModuleManifest, type ModuleManifest } from '@learnship/core-kernel';

/**
 * Manifest del módulo `mod.hello-world`. Sirve de plantilla de referencia
 * para futuros módulos y se valida en runtime contra el schema Zod del core.
 */
export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.hello-world',
  displayName: 'Hello World',
  description: 'Módulo de ejemplo. Plantilla de referencia para nuevos módulos.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'example',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_helloworld_',
  permissions: ['hello-world.greeting.read'],
  eventsEmitted: ['hello-world.greeting.requested'],
  eventsConsumed: [],
  apiNamespace: '/modules/hello-world',
});
