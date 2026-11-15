/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

/**
 * mod.soporte — «Ayuda y sugerencias».
 *
 * Traído de Community (VA360) con el mismo nombre, las mismas tablas y la
 * misma API de dominio, para que un arreglo pase de un repo a otro sin
 * traducir nada. En Didacta Cloud nace ENCENDIDO en todas las aulas (el
 * registro de este repo persiste todos los módulos con `enabledByDefault`):
 * un miembro siempre tiene a quién contarle un fallo. Cada aula puede apagarlo
 * desde Módulos (no es 'core').
 *
 * No lee ni escribe tablas de otros módulos (ADR-039): el host le pasa el
 * nombre del autor, quién administra el aula, el almacén de capturas, la
 * dirección pública del aula y el aviso al operador de la plataforma.
 */
export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.soporte',
  displayName: 'Ayuda y sugerencias · tickets de soporte',
  description:
    'Botón «Ayuda y sugerencias»: los miembros abren tickets (algo no funciona, tengo un ' +
    'problema, tengo una sugerencia) con captura opcional y los siguen en «Tus tickets»; ' +
    'el equipo del aula los gestiona con su estado y una nota interna.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  // NO es 'core': un aula puede apagarlo desde Módulos.
  category: 'community',
  coreVersionRequired: '^0.1.0',
  tablePrefix: 'mod_soporte_',
  permissions: ['soporte.send', 'soporte.manage'],
  dependencies: { modules: [], optionalModules: [] },
  eventsEmitted: ['soporte.ticket.created', 'soporte.ticket.status_changed'],
  eventsConsumed: [],
  apiNamespace: '/modules/soporte',
});
