import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.fundae',
  displayName: 'Fundae · Acciones formativas',
  description:
    'Gestión de acciones formativas Fundae (España): código de acción, modalidad, horas, fechas. Export XML para presentar a la fundación. v0.1: CRUD + XML básico.',
  version: '0.1.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'compliance',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_fundae_',
  permissions: [
    'fundae.action.read',
    'fundae.action.write',
    'fundae.export.read',
    'fundae.company.read',
    'fundae.company.write',
  ],
  dependencies: {
    modules: [],
    optionalModules: [{ name: 'mod.courses', version: '^1.0.0' }],
  },
  eventsEmitted: [
    'fundae.action.created',
    'fundae.action.updated',
    'fundae.action.archived',
    'fundae.export.generated',
    'fundae.company.created',
    'fundae.company.updated',
    'fundae.company.deleted',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/fundae',
});
