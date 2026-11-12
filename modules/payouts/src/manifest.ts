/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

/**
 * mod.payouts — cobros de plataforma.
 *
 * En las instalaciones que definen `PAYMENTS_PLATFORM_STRIPE_SECRET_KEY` (hoy,
 * solo Didacta Cloud) el alumno paga en la cuenta de Stripe del OPERADOR y el
 * módulo reparte: al creador le llega `venta − comisión real de Stripe −
 * comisión del operador`. Aquí vive el dominio del dinero: cuenta conectada,
 * reparto, libro mayor, deudas, reembolsos, disputas y conciliación.
 *
 * Sin esa variable el módulo es inerte: ni se consulta ni escribe una fila.
 * Community sigue con «pega tu clave de Stripe» y sin comisión.
 *
 * No importa `mod.billing` ni `mod.subscriptions`, y ellos no lo importan a
 * él: el host les pasa un adaptador de Stripe con opciones de Connect y
 * compone los tres (ver `apps/api/src/modules/payment-mode.resolver.ts`).
 */
export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.payouts',
  displayName: 'Cobros de plataforma',
  description:
    'El operador cobra en su cuenta de Stripe y reparte al creador: venta menos la comisión real de Stripe menos la comisión del operador. Cuenta conectada con alta alojada, libro mayor de solo inserción, deudas, reembolsos, disputas y conciliación.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^0.1.0',
  tablePrefix: 'mod_payouts_',
  permissions: [
    'payouts.account.read',
    'payouts.account.manage',
    'payouts.sale.read',
    'payouts.sale.refund',
  ],
  dependencies: {
    modules: [],
    optionalModules: [],
  },
  eventsEmitted: [],
  eventsConsumed: [],
  apiNamespace: '/modules/payouts',
});
