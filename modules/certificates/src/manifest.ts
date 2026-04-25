import { parseModuleManifest, type ModuleManifest } from '@learnship/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.certificates',
  displayName: 'Certificados',
  description: 'Plantillas, emisión PDF y descarga de certificados al completar un curso.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_certificates_',
  permissions: [
    'certificates.template.read',
    'certificates.template.write',
    'certificates.issue',
    'certificates.read',
  ],
  dependencies: {
    modules: [{ name: 'mod.learning', version: '^1.0.0' }],
    optionalModules: [],
  },
  eventsEmitted: ['certificates.issued', 'certificates.revoked'],
  eventsConsumed: ['learning.course.completed'],
  apiNamespace: '/modules/certificates',
});
