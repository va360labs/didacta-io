/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { getTranslations } from 'next-intl/server';
import { AuthHeading } from '../../auth-heading';
import { RedeemSupportAccess } from './redeem-support-access';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: t('supportAccess.metaTitle') };
}

/**
 * Canje de un acceso de soporte (U8).
 *
 * Vive en `(auth)` y no dentro del aula porque quien la abre todavía no tiene
 * sesión: la está pidiendo. El token llega en la query del enlace que generó
 * el panel, se canjea una sola vez y, si sale bien, la persona entra ya dentro
 * con el aviso rojo puesto.
 */
export default async function SoporteAccesoPage() {
  const t = await getTranslations('auth');
  return (
    <>
      <AuthHeading title={t('supportAccess.title')} description={t('supportAccess.description')} />
      <RedeemSupportAccess />
    </>
  );
}
