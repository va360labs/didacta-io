/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { UneteView } from './unete-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('publicSite');
  return { title: t('unete.metaTitle') };
}

/**
 * Página PÚBLICA de compra de la membresía. Todo el contenido (planes, cursos,
 * precios, testimonial) sale de la API real (`GET /api/v1/membership/page`,
 * tenant por dominio) — aquí no hay ni un dato inventado. El pago es Stripe
 * Checkout hosted (redirect).
 */
export default function UnetePage() {
  return (
    <Suspense fallback={null}>
      <UneteView />
    </Suspense>
  );
}
