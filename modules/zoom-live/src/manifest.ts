import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.zoom-live',
  displayName: 'Aula virtual (Zoom)',
  description:
    'Sesiones síncronas con Zoom asociadas opcionalmente a un curso. v0.1 con stub de Zoom API — la integración real lee credenciales Server-to-Server desde tenant_settings.',
  version: '0.1.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'live',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_zoom_',
  permissions: ['zoom.session.read', 'zoom.session.write'],
  dependencies: {
    modules: [],
    optionalModules: [{ name: 'mod.courses', version: '^1.0.0' }],
  },
  eventsEmitted: ['zoom.session.created', 'zoom.session.updated', 'zoom.session.cancelled'],
  eventsConsumed: [],
  apiNamespace: '/modules/zoom-live',
});
