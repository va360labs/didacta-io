/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { redirect } from 'next/navigation';

/**
 * Antes esta pantalla solo optimizaba portadas de curso. Ahora `/admin/imagenes`
 * cubre todas las imágenes de la plataforma (avatares, recursos, comunidad,
 * logo) incluidas esas mismas portadas, así que esto queda como redirección
 * para no tener dos caminos al mismo sitio ni romper enlaces guardados.
 */
export default function CourseImagesRedirect() {
  redirect('/admin/imagenes');
}
