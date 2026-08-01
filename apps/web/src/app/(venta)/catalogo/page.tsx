/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Suspense } from 'react';
import { CatalogoView } from './catalogo-view';

export const metadata = { title: 'Cursos' };

/**
 * Catálogo PÚBLICO de cursos sueltos (viaje 2): visible sin cuenta ni sesión.
 * El tenant se resuelve por dominio en la API; los precios salen de
 * mod.billing y solo aparecen cursos publicados con opciones de compra
 * activas. La compra es checkout anónimo de Stripe (la cuenta se crea tras
 * el pago).
 */
export default function CatalogoPage() {
  return (
    <Suspense fallback={<div className="skeleton h-96 w-full rounded-3xl" />}>
      <CatalogoView />
    </Suspense>
  );
}
