/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { SetupWizard } from './setup-wizard';

export const metadata: Metadata = {
  title: 'Configuración inicial · Didacta',
  description:
    'Asistente de primer arranque para crear tu organización y tu cuenta de administrador.',
};

export default function SetupPage() {
  return <SetupWizard />;
}
