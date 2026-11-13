/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InscripcionForm } from './inscripcion-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('publicSite');
  return { title: t('inscripcion.metaTitle') };
}

/**
 * Pantalla pública de inscripción de miembros (route group `(public)`, fuera
 * del gate de auth/onboarding). Server component que monta el wizard cliente.
 */
export default function InscripcionMiembrosPage() {
  return <InscripcionForm />;
}
