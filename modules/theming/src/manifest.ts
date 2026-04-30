import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.theming',
  displayName: 'Personalización visual',
  description:
    'Branding y theming per-tenant: logo, favicon, color primario (hue HSL), fuentes y custom CSS sanitizado. Override de los design tokens del sistema.',
  version: '0.1.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_theming_',
  permissions: ['theming.read', 'theming.write'],
  dependencies: {
    modules: [],
    optionalModules: [],
  },
  eventsEmitted: ['theming.logo.uploaded'],
  eventsConsumed: [],
  apiNamespace: '/modules/theming',
});
