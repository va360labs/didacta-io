/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { redirect } from 'next/navigation';

/**
 * `/events` se fusionó con `/calendar` (bloque 9 — simplificar navegación):
 * la lista con inscripción vive en la pestaña "Eventos" del calendario. La ruta
 * se conserva como redirect para enlaces guardados y marcadores.
 */
export default function EventosPage() {
  redirect('/calendar?view=events');
}
