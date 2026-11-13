/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CondicionesReferidosView } from './condiciones-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('referidosCondiciones');
  return { title: t('metaTitle') };
}

/**
 * Condiciones PÚBLICAS del programa «Invita y gana» de un aula (sin sesión):
 * a ellas enlaza la casilla de aceptación. Las cifras (porcentaje, días de
 * atribución y de garantía, mínimo de cobro, tope del descuento) salen de la
 * configuración real del aula (`GET /modules/referrals/public/terms`).
 */
export default function CondicionesReferidosPage() {
  return <CondicionesReferidosView />;
}
