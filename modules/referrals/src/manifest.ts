/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.referrals',
  displayName: 'Programa de referidos',
  description:
    'Los miembros recomiendan la membresía con un enlace propio y reciben un % de los cobros reales de quien entra. Atribución vía metadata de Stripe Checkout, comisiones con periodo de garantía y liquidación manual trazable (sin Stripe Connect en v1).',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_referrals_',
  permissions: ['referrals.code.read', 'referrals.commission.manage', 'referrals.config.manage'],
  dependencies: {
    modules: [],
    // Lectura acotada de mod_subscriptions_subscription (¿membresía activa del
    // referidor?) filtrando por tenant_id — permitida por ADR-016 declarándola.
    optionalModules: [{ name: 'mod.subscriptions', version: '^1.0.0' }],
  },
  eventsEmitted: [
    'referrals.referral.attributed',
    'referrals.commission.created',
    'referrals.commission.approved',
    'referrals.commission.revoked',
    'referrals.payout.recorded',
  ],
  eventsConsumed: [
    'subscriptions.membership.activated',
    'subscriptions.invoice.paid',
    'subscriptions.invoice.refunded',
  ],
  apiNamespace: '/modules/referrals',
});
