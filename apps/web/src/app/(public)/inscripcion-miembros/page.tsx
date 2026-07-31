/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { InscripcionForm } from './inscripcion-form';

export const metadata: Metadata = {
  title: 'Inscripción de miembros',
};

/**
 * Pantalla pública de inscripción de miembros (route group `(public)`, fuera
 * del gate de auth/onboarding). Server component que monta el wizard cliente.
 */
export default function InscripcionMiembrosPage() {
  return <InscripcionForm />;
}
