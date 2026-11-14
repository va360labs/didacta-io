'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { AtRiskMembers } from '@/modules/retention';

/**
 * Miembros en riesgo. Una sola ruta para los dos modos: en el sencillo se llega
 * desde «Alumnos» y en el completo desde Usuarios. La pantalla vive en
 * mod.retention; esto solo la monta.
 */
export default function MiembrosEnRiesgoPage() {
  return <AtRiskMembers />;
}
