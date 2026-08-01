/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Suspense } from 'react';
import { FichaVentaView } from './ficha-venta-view';

export const metadata = { title: 'Curso' };

/**
 * Ficha PÚBLICA de venta de un curso suelto (viaje 2): visible sin sesión.
 * Muestra las opciones de compra reales de mod.billing y lanza el checkout
 * anónimo de Stripe. La ficha completa del alumno (temario, progreso) sigue
 * en /cursos/[slug] tras iniciar sesión.
 */
export default function FichaVentaPage() {
  return (
    <Suspense fallback={<div className="skeleton h-96 w-full rounded-3xl" />}>
      <FichaVentaView />
    </Suspense>
  );
}
