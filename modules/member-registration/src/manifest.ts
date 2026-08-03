/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

/**
 * mod.member-registration — inscripción de miembros: solicitud → evidencia →
 * decisión humana.
 *
 * Capa genérica de alta con validación manual: el solicitante aporta la
 * evidencia que exige la política del tenant (verificadores componibles:
 * Telegram y/u OTP por email, o registro libre) y un aprobador decide con
 * 1 click desde el email o desde el panel admin. Incluye la lista de impagos
 * de referencia y el lookup de suscripciones/compras del solicitante en las
 * cuentas de pago conectadas (vía mod.payment-connections).
 *
 * La aprobación asigna el grupo de acceso por defecto del tenant vía
 * mod.access-groups (dependencia dura desde su formalización en F6); el
 * wiring corre por el host.
 */
export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.member-registration',
  displayName: 'Inscripción de miembros',
  description:
    'Alta de miembros con verificadores componibles por tenant (Telegram y/u OTP por email, o registro libre) y validación manual del aprobador. Con lista de impagos y lookup de suscripciones en las cuentas de pago conectadas.',
  version: '1.0.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'core',
  coreVersionRequired: '^0.0.1',
  tablePrefix: 'mod_member_registration_',
  permissions: [
    'member_registration.request.read',
    'member_registration.request.decide',
    'member_registration.payment_flag.manage',
  ],
  dependencies: {
    modules: [
      { name: 'mod.payment-connections', version: '^1.0.0' },
      { name: 'mod.access-groups', version: '^1.0.0' },
    ],
    optionalModules: [],
  },
  eventsEmitted: [
    'member_registration.request.created',
    'member_registration.request.approved',
    'member_registration.request.rejected',
  ],
  eventsConsumed: [],
  apiNamespace: '/modules/member-registration',
});
