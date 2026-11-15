'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Suspense } from 'react';
import { AdminSoporte } from '@/modules/soporte';

/**
 * Bandeja del equipo de «Ayuda y sugerencias» (mod.soporte): los tickets del
 * aula. La pantalla vive en el módulo; aquí solo se monta. Solo super_admin y
 * tenant_admin; la API lo exige y responde 403 con el módulo apagado.
 */
export default function BandejaSoportePage() {
  return (
    <Suspense fallback={<div className="skeleton h-10 w-72 max-w-full" />}>
      <AdminSoporte />
    </Suspense>
  );
}
