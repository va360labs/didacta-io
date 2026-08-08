/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { SetupWizard } from './setup-wizard';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth');
  return {
    title: t('setup.metaTitle'),
    description: t('setup.metaDescription'),
  };
}

export default function SetupPage() {
  // SetupWizard lee `?token=` con useSearchParams (el token de un solo uso
  // impreso en los logs del contenedor al primer arranque) — exige Suspense
  // en el árbol, mismo patrón que reset-password/page.tsx.
  return (
    <Suspense>
      <SetupWizard />
    </Suspense>
  );
}
