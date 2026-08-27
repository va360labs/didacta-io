/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.fundae',
  displayName: 'Fundae · Acciones formativas',
  description:
    'Gestión de acciones formativas Fundae (España): código de acción, modalidad, horas, fechas. Export XML para presentar a la fundación. v0.1: CRUD + XML básico.',
  version: '0.4.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'compliance',
  coreVersionRequired: '^0.1.0',
  tablePrefix: 'mod_fundae_',
  permissions: [
    'fundae.action.read',
    'fundae.action.write',
    'fundae.export.read',
    'fundae.company.read',
    'fundae.company.write',
    'fundae.rlpt.read',
    'fundae.rlpt.write',
    'fundae.group.read',
    'fundae.group.write',
    'fundae.cost.read',
    'fundae.cost.write',
    'fundae.group.participant.read',
    'fundae.group.participant.write',
    // Acceso de seguimiento (LMS-123): conceder/retirar es admin; leer el
    // expediente lo hace la propia inspección con su concesión.
    'fundae.inspector.read',
    'fundae.inspector.write',
  ],
  dependencies: {
    modules: [],
    // mod.learning: se leen matrículas/completitud para FUNDAE (lectura
    // cross-table, módulo core in-tree — ADR-016). mod.courses: validación de curso.
    optionalModules: [
      { name: 'mod.courses', version: '^1.0.0' },
      { name: 'mod.learning', version: '^1.0.0' },
    ],
  },
  eventsEmitted: [
    'fundae.action.created',
    'fundae.action.updated',
    'fundae.action.archived',
    'fundae.export.generated',
    'fundae.company.created',
    'fundae.company.updated',
    'fundae.company.deleted',
    'fundae.rlpt.notice.created',
    'fundae.rlpt.notice.deleted',
    'fundae.group.created',
    'fundae.group.updated',
    'fundae.group.started',
    'fundae.group.closed',
    'fundae.group.cancelled',
    'fundae.cost.added',
    'fundae.cost.updated',
    'fundae.cost.removed',
    'fundae.group.participant.enrolled',
    'fundae.group.participant.bulk-enrolled',
    'fundae.group.participant.updated',
    'fundae.group.participant.removed',
    'fundae.group.start-xml.generated',
    'fundae.group.completion-computed',
    'fundae.group.end-xml.generated',
    'fundae.group.audit-zip.generated',
    'fundae.inspector.granted',
    'fundae.inspector.revoked',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/fundae',
});
