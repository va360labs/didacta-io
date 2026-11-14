/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

/**
 * mod.retention — mensajes automáticos y miembros en riesgo.
 *
 * Módulo NUEVO y no una ampliación de mod.messaging o mod.community (ADR-039,
 * opción B): los disparadores salen de cuatro módulos distintos (learning,
 * community, gamification, subscriptions) y meterlos en la mensajería la haría
 * depender de todos ellos. Aquí la mensajería es solo el CANAL: se le pide por
 * su servicio público que entregue un mensaje directo, como se le pide al hub
 * que mande un correo.
 *
 * No lee ni escribe tablas de otros módulos: todo lo que necesita del aula
 * (miembros, matrículas, pagos, si es su primera publicación…) se lo da el host
 * por los puertos de `RetentionPorts`, y los hechos le llegan por eventos
 * declarados aquí abajo.
 */
export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.retention',
  displayName: 'Retención · mensajes automáticos y miembros en riesgo',
  description:
    'Mensajes directos que el aula programa (bienvenida, primera semana, primer mes, ' +
    'recuperación si alguien deja de entrar, curso terminado, primera publicación, ' +
    'subida de nivel y aniversario), con copia opcional por correo y reglas anti-spam, ' +
    'y el panel de miembros en riesgo para escribirles a tiempo.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  // NO es 'core': un aula puede apagarlo entero desde Módulos.
  category: 'community',
  coreVersionRequired: '^0.1.0',
  tablePrefix: 'mod_retention_',
  permissions: ['retention.manage'],
  dependencies: {
    // El canal: sin mensajería no hay a dónde mandar el mensaje directo.
    modules: [{ name: 'mod.messaging', version: '^1.0.0' }],
    // Solo como origen de EVENTOS y de los datos que el host pasa por los
    // puertos; nunca se leen sus tablas desde aquí.
    optionalModules: [
      { name: 'mod.learning', version: '^1.0.0' },
      { name: 'mod.community', version: '^1.0.0' },
      { name: 'mod.gamification', version: '^1.0.0' },
      { name: 'mod.subscriptions', version: '^1.0.0' },
    ],
  },
  eventsEmitted: ['retention.message.sent'],
  eventsConsumed: [
    'learning.course.completed',
    'community.post.created',
    'gamification.level.changed',
  ],
  apiNamespace: '/modules/retention',
});
