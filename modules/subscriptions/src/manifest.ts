/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.subscriptions',
  displayName: 'Suscripciones recurrentes (Stripe)',
  description:
    'Suscripciones mensuales/anuales con Stripe. Maneja activación, grace period tras impago, dunning y cancelación. Se integra con mod.learning vía eventos.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^0.1.0',
  tablePrefix: 'mod_subscriptions_',
  permissions: [
    'subscriptions.subscription.read',
    'subscriptions.subscription.create',
    'subscriptions.subscription.cancel',
  ],
  dependencies: {
    modules: [
      { name: 'mod.learning', version: '^1.0.0' },
      { name: 'mod.courses', version: '^1.0.0' },
    ],
    // Niveles de la membresía: la página pública nombra los cursos de cada
    // nivel leyendo su grupo de acceso (solo lectura, filtrada por tenant).
    // Y nombra los espacios (mod.community) y los próximos directos
    // (mod.zoom-live) restringidos a cada nivel: lo compone el host con los
    // services públicos de esos módulos.
    optionalModules: [
      { name: 'mod.access-groups', version: '^1.0.0' },
      { name: 'mod.community', version: '^1.0.0' },
      { name: 'mod.zoom-live', version: '^1.0.0' },
    ],
  },
  eventsEmitted: [
    'subscriptions.subscription.created',
    'subscriptions.subscription.activated',
    'subscriptions.subscription.past_due',
    'subscriptions.subscription.unpaid',
    'subscriptions.subscription.canceled',
    // Empieza una pausa aceptada en la oferta al darse de baja (fuera acceso).
    'subscriptions.subscription.paused',
    'subscriptions.invoice.paid',
    'subscriptions.invoice.payment_failed',
    'subscriptions.invoice.refunded',
    'subscriptions.invoice.partially_refunded',
    // Membresía (página pública /join): concede/revoca un grupo de acceso.
    'subscriptions.membership.activated',
    'subscriptions.membership.revoked',
    // Cambio de plan/nivel desde la cuenta del alumno (o reconciliado por el
    // webhook): el host concede el grupo del nivel nuevo y retira el viejo.
    'subscriptions.membership.plan_changed',
    // Oferta al darse de baja: lo que eligió el alumno (correos de confirmación).
    'subscriptions.retention.paused',
    'subscriptions.retention.discounted',
    'subscriptions.retention.canceled',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/subscriptions',
});
