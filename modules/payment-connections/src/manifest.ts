/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

/**
 * mod.payment-connections — agregador de SOLO LECTURA.
 *
 * El admin conecta varias cuentas de Stripe (clave API restringida read-only,
 * cifrada en tenant_setting) y el módulo lee las suscripciones activas de cada
 * cuenta para reconciliarlas contra los usuarios de Didacta por email.
 *
 * No crea cobros (eso es mod.billing/mod.subscriptions). No comparte tablas con
 * ellos (regla del contrato modular). Preparado multi-proveedor desde el día 1
 * (columna `provider`); PayPal queda para una fase posterior porque su API no
 * permite listar todas las suscripciones de una cuenta.
 *
 * Emite `payment_connections.user_tier.changed` cuando el tier efectivo de un
 * usuario cambia (sync de pagos o asignación manual). mod.access-groups lo
 * consume para reconciliar la membresía de los grupos vinculados (vínculo
 * tier→grupo, auto-matrícula). Ver PRD "DRIP de lecciones por tier/grupo".
 */
export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.payment-connections',
  displayName: 'Conexiones de pago (Stripe)',
  description:
    'Conecta varias cuentas de Stripe en modo solo lectura y reconcilia las suscripciones activas contra los usuarios de Didacta por email. Preparado multi-proveedor (PayPal en roadmap).',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^0.0.1',
  tablePrefix: 'mod_payment_connections_',
  permissions: [
    'payment_connections.connection.read',
    'payment_connections.connection.create',
    'payment_connections.connection.update',
    'payment_connections.connection.delete',
  ],
  dependencies: {
    modules: [],
    optionalModules: [],
  },
  eventsEmitted: ['payment_connections.user_tier.changed'],
  eventsConsumed: [],
  apiNamespace: '/modules/payment-connections',
});
