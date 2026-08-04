/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SetupWizard } from './setup-wizard';

export const metadata: Metadata = {
  title: 'Configuración inicial · Didacta',
  description:
    'Asistente de primer arranque para crear tu organización y tu cuenta de administrador.',
};

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
