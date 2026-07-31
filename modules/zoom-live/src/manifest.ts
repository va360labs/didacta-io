/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.zoom-live',
  displayName: 'Aula virtual (Zoom)',
  description:
    'Clases en directo con Zoom: sesiones asociadas opcionalmente a un curso, inscripción por sesión con enlace compartible (/clase/[id]) y joinUrl/grabación gateados a inscritos (ADR-017). Al inscribirse se ofrece guardar la clase en el calendario (Google, Outlook, .ics) y se avisa por email 2h antes. Asistencia real por proxy de entrada + reconciliación con la Report API de Zoom (ADR-018). Integración Server-to-Server real con credenciales per-tenant; stub determinístico sin credenciales.',
  version: '0.4.0',
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
  eventsEmitted: [
    'zoom.session.created',
    'zoom.session.updated',
    'zoom.session.cancelled',
    'zoom.session.started',
    'zoom.session.ended',
    'zoom.session.recording_ready',
    'zoom.session.registration.created',
    'zoom.session.registration.cancelled',
    'zoom.session.attendance_synced',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/zoom-live',
});
