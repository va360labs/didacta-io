/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.surveys',
  displayName: 'Encuestas y NPS',
  description:
    'Encuestas anónimas de la comunidad: encuesta automática al terminar cada clase en directo (NPS + valoración) con resultados agregados para el admin.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  // A propósito NO es 'core': un tenant puede desactivar las encuestas
  // (los módulos core son indesactivables y se re-habilitan en cada boot).
  category: 'engagement',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_surveys_',
  permissions: ['surveys.response.write', 'surveys.results.read', 'surveys.manage'],
  dependencies: {
    modules: [],
    // Lectura acotada de mod_zoom_live_session_registration (ADR-016) para avisar a
    // los inscritos al crear la encuesta post-clase. Solo lectura, nunca escritura.
    optionalModules: [{ name: 'mod.zoom-live', version: '^0.3.0' }],
  },
  eventsEmitted: ['surveys.survey.created', 'surveys.response.submitted'],
  eventsConsumed: ['zoom.session.ended'],
  apiNamespace: '/modules/surveys',
});
