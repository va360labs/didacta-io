'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Suspense } from 'react';
import { TusTickets } from '@/modules/soporte';

/**
 * «Tus tickets» de «Ayuda y sugerencias» (mod.soporte). La pantalla vive en el
 * módulo; aquí solo se monta. Se llega desde el botón «Ayuda y sugerencias»
 * (enlace «Ver tus tickets»), desde la campana y desde el correo de cambio de
 * estado. Con el módulo apagado, la API responde 403 y la pantalla lo dice.
 */
export default function TusTicketsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3">
          <div className="skeleton h-10 w-72 max-w-full" />
          <div className="skeleton h-5 w-96 max-w-full" />
        </div>
      }
    >
      <TusTickets />
    </Suspense>
  );
}
