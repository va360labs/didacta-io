/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ReactNode } from 'react';

/**
 * Envoltura del sitio público.
 *
 * Existe para que el sitio NO herede el armazón del aula: cabecera de alumno,
 * navegación con sesión, y el 404 del aula. Enseñar cualquiera de esas cosas
 * en un dominio comercial delata que detrás hay otro producto, y en el caso
 * del 404 le da a un visitante anónimo una pista sobre la instancia.
 *
 * Deliberadamente vacío de cromo: la cabecera y el pie del sitio son
 * contenido, y los aporta el módulo que sirve la ruta.
 */
export default function SitioLayout({ children }: { children: ReactNode }) {
  return children;
}
