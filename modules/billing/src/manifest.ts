/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.billing',
  displayName: 'Stripe Checkout (pago único de cursos)',
  description:
    'Vincula cursos con Stripe Prices, gestiona checkout sessions y enrolla al alumno tras pago vía webhook idempotente.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_billing_',
  permissions: [
    'billing.product.read',
    'billing.product.write',
    'billing.order.read',
    'billing.checkout.create',
  ],
  dependencies: {
    modules: [
      { name: 'mod.learning', version: '^1.0.0' },
      { name: 'mod.courses', version: '^1.0.0' },
    ],
    optionalModules: [],
  },
  eventsEmitted: [
    'billing.order.created',
    'billing.order.completed',
    'billing.order.failed',
    'billing.order.refunded',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/billing',
});
