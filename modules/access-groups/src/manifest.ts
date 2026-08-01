/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

/**
 * mod.access-groups — grupos de acceso configurables.
 *
 * Un grupo otorga acceso a un SET de cursos (todos, uno o varios). El acceso se
 * materializa como matrículas del core (`source = GROUP`) vía mod.learning, con
 * provenance/refcount para revocar de forma segura: un curso solo se
 * desmatricula cuando ningún grupo vivo lo otorga.
 *
 * Los miembros llegan por tres vías, y cada una es dueña de lo suyo:
 *   - MANUAL: alta del admin (o aprobación de inscripción). Solo la retira un
 *     admin — es "sticky" frente a los bridges automáticos.
 *   - TIER: reconciliada por el vínculo tier→grupo (mod.payment-connections).
 *   - MEMBERSHIP: concedida por la membresía de pago (mod.subscriptions).
 *
 * La orquestación NestJS (controller, service Prisma y bridges de eventos) vive
 * en el host: apps/api/src/modules/access-groups/ (ADR-011/015).
 */
export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.access-groups',
  displayName: 'Grupos de acceso',
  description:
    'Grupos configurables que otorgan acceso a un set de cursos (todos, uno o varios). El acceso se materializa como matrículas del core con provenance y refcount; los miembros entran por alta manual, por tier de pago o por membresía.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_access_groups_',
  permissions: [
    'access_groups.group.read',
    'access_groups.group.manage',
    'access_groups.member.manage',
  ],
  dependencies: {
    // El entitlement SE MATERIALIZA en mod.learning y el catálogo de cursos
    // sale de mod.courses — sin ellos el módulo no tiene nada que otorgar.
    modules: [
      { name: 'mod.courses', version: '^1.0.0' },
      { name: 'mod.learning', version: '^1.0.0' },
    ],
    // Vías de entrada opcionales: el vínculo tier→grupo y el grupo de la
    // membresía funcionan solo si esos módulos están (mod.subscriptions no se
    // registra sin Stripe configurado).
    optionalModules: [
      { name: 'mod.payment-connections', version: '^1.0.0' },
      { name: 'mod.subscriptions', version: '^1.0.0' },
    ],
  },
  eventsEmitted: [],
  eventsConsumed: [
    'courses.course.published',
    'payment_connections.user_tier.changed',
    'subscriptions.membership.activated',
    'subscriptions.subscription.activated',
    'subscriptions.subscription.canceled',
    'subscriptions.subscription.unpaid',
  ],
  apiNamespace: '/modules/access-groups',
});
